import vm from 'node:vm';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { createHash } from 'node:crypto';

export interface RuntimeConfig {
  sourceKey: string;
  limiter: RateLimiter;
  cpuTimeoutMs?: number;
}

type HttpResponse = { isOk: boolean; code: number; body: string };

/**
 * Full Grayjay plugin runtime using Node's vm module.
 *
 * The sandbox provides Grayjay host bindings:
 * - http.GET / http.POST / httpGET / httpPOST — routed through prefetched responses
 * - domParser.parseFromString / DOMParser — cheerio-based HTML parsing
 * - atob / btoa — Base64 encoding
 * - utility — sha1/sha256/md5, URL helpers
 * - Platform classes — PlatformID, PlatformChannel, PlatformAuthorLink, pagers, exceptions
 *
 * Security: the vm sandbox has no access to process, require, import,
 * fs, child_process, or any Node internals. The only escape is through
 * the host functions we explicitly provide.
 */
export class PluginRuntime {
  private sandbox: vm.Context;
  private config: RuntimeConfig;
  private initialized = false;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sandbox = this.createSandbox();
  }

  private createSandbox(): vm.Context {
    const self = this;

    const sandbox: Record<string, unknown> = {
      // ---- Console ----
      console: {
        log: (...args: unknown[]) => {
          process.stderr.write(`[plugin:${self.config.sourceKey}] ${args.join(' ')}\n`);
        },
        error: (...args: unknown[]) => {
          process.stderr.write(`[plugin:${self.config.sourceKey}:ERR] ${args.join(' ')}\n`);
        },
        warn: () => {},
        info: () => {},
        debug: () => {},
      },

      // ---- Base64 ----
      atob: (str: string) => Buffer.from(str, 'base64').toString('utf-8'),
      btoa: (str: string) => Buffer.from(str, 'utf-8').toString('base64'),

      // ---- JSON ----
      JSON,

      // ---- HTTP stubs (overridden per-execution with prefetched responses) ----
      http: {
        GET: (_url: string, _headers?: Record<string, string>, _useAuth?: boolean): HttpResponse => {
          throw new Error('HTTP not available outside execution context');
        },
        POST: (_url: string, _body: string, _headers?: Record<string, string>, _useAuth?: boolean): HttpResponse => {
          throw new Error('HTTP not available outside execution context');
        },
        batch: () => {
          const requests: { method: string; url: string; body: string; headers: Record<string, string> }[] = [];
          const batchObj = {
            POST: (url: string, body: string, headers: Record<string, string>, useAuth: boolean) => {
              requests.push({ method: 'POST', url, body, headers: headers || {} });
            },
            GET: (url: string, headers: Record<string, string>, useAuth: boolean) => {
              requests.push({ method: 'GET', url, body: '', headers: headers || {} });
            },
            execute: () => {
              // @ts-ignore — __prefetched is injected at runtime via vm.runInContext
              const cache = (globalThis as any).__prefetched || __prefetched || {};
              return requests.map(r => {
                const key = r.method + ':' + r.url + ':' + r.body;
                const keyNoBody = r.method + ':' + r.url;
                if (cache[key]) return cache[key];
                if (cache[keyNoBody]) return cache[keyNoBody];
                throw new Error('No prefetched batch response for: ' + r.method + ' ' + r.url);
              });
            },
          };
          return batchObj;
        },
      },

      httpGET: (_urlOrObj: unknown): HttpResponse => {
        throw new Error('HTTP not available outside execution context');
      },
      httpPOST: (_url: string, _body: string, _headers?: Record<string, string>, _useAuth?: boolean): HttpResponse => {
        throw new Error('HTTP not available outside execution context');
      },

      // ---- DOM parser (cheerio-based) ----
      domParser: {
        parseFromString: (html: string, _mimeType: string) => self.createDomWrapper(html),
      },
      DOMParser: class {
        parseFromString(html: string, mimeType: string) {
          return self.createDomWrapper(html);
        }
      },

      // ---- Source lifecycle ----
      source: {} as Record<string, unknown>,

      // ---- Grayjay platform classes ----
      PlatformID: class PlatformID {
        platform: string;
        id: string;
        pluginId: string;
        claimType: number;
        claimFieldType: number | undefined;
        constructor(platform: string, id: string, pluginId: string, claimType = 0, claimFieldType?: number) {
          this.platform = platform;
          this.id = id;
          this.pluginId = pluginId;
          this.claimType = claimType;
          this.claimFieldType = claimFieldType;
        }
      },

      PlatformChannel: class PlatformChannel {
        id: unknown;
        name: string;
        thumbnail: string;
        banner: string;
        subscribers: number | undefined;
        description: string;
        url: string;
        links: Record<string, string>;
        constructor(opts: Record<string, unknown>) {
          this.id = opts.id;
          this.name = (opts.name as string) ?? '';
          this.thumbnail = (opts.thumbnail as string) ?? '';
          this.banner = (opts.banner as string) ?? '';
          this.subscribers = opts.subscribers as number | undefined;
          this.description = (opts.description as string) ?? '';
          this.url = (opts.url as string) ?? '';
          this.links = (opts.links as Record<string, string>) ?? {};
        }
      },

      PlatformAuthorLink: class PlatformAuthorLink {
        id: unknown;
        name: string;
        url: string;
        thumbnail: string;
        subscribers: number | undefined;
        constructor(id: unknown, name: string, url: string, thumbnail: string, subscribers?: number) {
          this.id = id;
          this.name = name;
          this.url = url;
          this.thumbnail = thumbnail;
          this.subscribers = subscribers;
        }
      },

      // ---- Pager classes ----
      VideoPager: class VideoPager {
        results: unknown[];
        hasMore: boolean;
        context: unknown;
        constructor(results: unknown[] = [], hasMore = false, context: unknown = {}) {
          this.results = results;
          this.hasMore = hasMore;
          this.context = context;
        }
        nextPage() { return this; }
      },

      ChannelPager: class ChannelPager {
        results: unknown[];
        hasMore: boolean;
        constructor(results: unknown[] = [], hasMore = false) {
          this.results = results;
          this.hasMore = hasMore;
        }
        nextPage() { return this; }
      },

      ContentPager: class ContentPager {
        results: unknown[];
        hasMore: boolean;
        constructor(results: unknown[] = [], hasMore = false) {
          this.results = results;
          this.hasMore = hasMore;
        }
        nextPage() { return this; }
      },

      Comment: class Comment {
        contextUrl: string;
        author: unknown;
        message: string;
        rating: unknown;
        date: number;
        replyCount: number;
        context: unknown;
        constructor(obj: Record<string, unknown>) {
          this.contextUrl = (obj.contextUrl as string) ?? '';
          this.author = obj.author;
          this.message = (obj.message as string) ?? '';
          this.rating = obj.rating;
          this.date = (obj.date as number) ?? 0;
          this.replyCount = (obj.replyCount as number) ?? 0;
          this.context = obj.context;
        }
      },

      CommentPager: class CommentPager {
        results: unknown[];
        hasMore: boolean;
        context: unknown;
        constructor(results: unknown[] = [], hasMore = false, context: unknown = {}) {
          this.results = results;
          this.hasMore = hasMore;
          this.context = context;
        }
        nextPage() { return this; }
      },

      // ---- Media/Content classes (stubs for video parsing) ----
      PlatformVideo: class PlatformVideo {
        id: unknown; author: unknown; title = ''; description = ''; thumbnails: unknown[] = [];
        url = ''; datetime: number | undefined; duration = 0; views: number | undefined;
        constructor(obj: Record<string, unknown>) {
          Object.assign(this, obj);
        }
      },
      PlatformVideoDetails: class PlatformVideoDetails {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      PlatformPlaylist: class PlatformPlaylist {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      PlatformPlaylistDetails: class PlatformPlaylistDetails {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      VideoSourceDescriptor: class VideoSourceDescriptor {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      VideoUrlSource: class VideoUrlSource {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      HLSSource: class HLSSource {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      Thumbnail: class Thumbnail {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      Thumbnails: class Thumbnails {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      RatingLikesDislikes: class RatingLikesDislikes {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      RatingLikes: class RatingLikes {
        constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
      },
      LoginRequiredException: class LoginRequiredException extends Error {
        constructor(msg: string) { super(msg); this.name = 'LoginRequiredException'; }
      },
      CaptchaRequiredException: class CaptchaRequiredException extends Error {
        constructor(msg: string) { super(msg); this.name = 'CaptchaRequiredException'; }
      },

      // ---- Exception classes ----
      ScriptException: class ScriptException extends Error {
        constructor(msg: string) { super(msg); this.name = 'ScriptException'; }
      },
      UnavailableException: class UnavailableException extends Error {
        constructor(msg: string) { super(msg); this.name = 'UnavailableException'; }
      },

      // ---- Bridge ----
      bridge: {
        buildPlatform: 'desktop',
        authUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        captchaUserAgent: undefined,
      },

      // ---- Logging ----
      log: (...args: unknown[]) => {
        process.stderr.write(`[plugin:${self.config.sourceKey}] ${args.join(' ')}\n`);
      },

      // ---- Crypto hashes ----
      SHA1: (str: string) => createHash('sha1').update(str).digest('hex'),
      SHA256: (str: string) => createHash('sha256').update(str).digest('hex'),
      MD5: (str: string) => createHash('md5').update(str).digest('hex'),

      // ---- Built-in JS globals (explicit for vm context) ----
      Date,
      Math,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      RegExp,
      Error,
      TypeError,
      RangeError,
      URIError,
      SyntaxError,
      ReferenceError,
      Number,
      String,
      Array,
      Object,
      Map,
      Set,
      Symbol,
      Promise,
      Proxy,
      WeakMap,
      WeakSet,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      Infinity,
      NaN,
      undefined,

      // ---- Prefetched response cache (injected per-execution) ----
      __prefetched: {} as Record<string, HttpResponse>,

      // ---- Testing / config flags ----
      IS_TESTING: false,
      isAndroid: false,
      state: {} as Record<string, unknown>,
      _config: { id: 'untether' } as Record<string, unknown>,
      _settings: {} as Record<string, unknown>,
      config: { id: 'untether' } as Record<string, unknown>,
      settings: {} as Record<string, unknown>,
    };

    return vm.createContext(sandbox);
  }

  /**
   * Load the plugin source into the sandbox and call source.enable().
   */
  loadAndEnable(source: string): void {
    try {
      // Run the plugin source — defines source.searchChannels, source.getChannel, etc.
      vm.runInContext(source, this.sandbox, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });

      // Call source.enable(config, settings, null)
      vm.runInContext(`source.enable({ id: 'untether' }, {}, null)`, this.sandbox, {
        timeout: 5000,
      });

      this.initialized = true;
    } catch (err) {
      process.stderr.write(`[runtime:${this.config.sourceKey}] Failed to load plugin: ${err}\n`);
      throw err;
    }
  }

  /**
   * Execute source.searchChannels(query) with pre-fetched HTTP responses.
   */
  executeSearchChannels(
    query: string,
    prefetchedResponses: Map<string, HttpResponse>,
  ): unknown[] {
    if (!this.initialized) throw new Error('Plugin not loaded');

    const responseMap: Record<string, HttpResponse> = {};
    for (const [key, value] of prefetchedResponses) {
      responseMap[key] = value;
    }

    // Inject prefetched responses and override HTTP functions
    vm.runInContext(`var __prefetched = ${JSON.stringify(responseMap)};`, this.sandbox, { timeout: 1000 });

    vm.runInContext(`
      httpGET = function(urlOrObj) {
        var url = typeof urlOrObj === 'object' ? urlOrObj.url : urlOrObj;
        var key = 'GET:' + url;
        if (__prefetched[key]) return __prefetched[key];
        throw new Error('No prefetched response for: GET ' + url);
      };
      httpPOST = function(url, body, headers, useAuth) {
        var key = 'POST:' + url + ':' + (body || '');
        if (__prefetched[key]) return __prefetched[key];
        var keyNoBody = 'POST:' + url;
        if (__prefetched[keyNoBody]) return __prefetched[keyNoBody];
        throw new Error('No prefetched response for: POST ' + url);
      };
      http.GET = function(url, headers, useAuth) { return httpGET(url); };
      http.POST = function(url, body, headers, useAuth) { return httpPOST(url, body, headers, useAuth); };
    `, this.sandbox, { timeout: 1000 });

    try {
      const result = vm.runInContext(`
        (function() {
          try {
            var pager = source.searchChannels(${JSON.stringify(query)});
            if (pager && pager.results) return pager.results;
            if (Array.isArray(pager)) return pager;
            return [];
          } catch(e) {
            return { __error: e.message || String(e) };
          }
        })()
      `, this.sandbox, { timeout: this.config.cpuTimeoutMs ?? 10000 });

      if (result && typeof result === 'object' && '__error' in result) {
        process.stderr.write(`[runtime:${this.config.sourceKey}] searchChannels error: ${(result as Record<string, string>).__error}\n`);
        return [];
      }

      return Array.isArray(result) ? (result as unknown[]) : [];
    } catch (err) {
      process.stderr.write(`[runtime:${this.config.sourceKey}] Execution error: ${err}\n`);
      return [];
    }
  }

  /**
   * Execute source.getChannel(url) with pre-fetched HTTP responses.
   */
  executeGetChannel(
    url: string,
    prefetchedResponses: Map<string, HttpResponse>,
  ): Record<string, unknown> | null {
    if (!this.initialized) return null;

    const responseMap: Record<string, HttpResponse> = {};
    for (const [key, value] of prefetchedResponses) {
      responseMap[key] = value;
    }

    vm.runInContext(`var __prefetched = ${JSON.stringify(responseMap)};`, this.sandbox, { timeout: 1000 });

    vm.runInContext(`
      httpGET = function(urlOrObj) {
        var url = typeof urlOrObj === 'object' ? urlOrObj.url : urlOrObj;
        var key = 'GET:' + url;
        if (__prefetched[key]) return __prefetched[key];
        throw new Error('No prefetched response for: GET ' + url);
      };
      httpPOST = function(url, body, headers, useAuth) {
        var key = 'POST:' + url + ':' + (body || '');
        if (__prefetched[key]) return __prefetched[key];
        var keyNoBody = 'POST:' + url;
        if (__prefetched[keyNoBody]) return __prefetched[keyNoBody];
        throw new Error('No prefetched response for: POST ' + url);
      };
      http.GET = function(url, headers, useAuth) { return httpGET(url); };
      http.POST = function(url, body, headers, useAuth) { return httpPOST(url, body, headers, useAuth); };
      http.batch = function() {
        var requests = [];
        return {
          POST: function(url, body, headers, useAuth) { requests.push({ method: 'POST', url: url, body: body, headers: headers }); },
          GET: function(url, headers, useAuth) { requests.push({ method: 'GET', url: url, body: '', headers: headers }); },
          execute: function() {
            return requests.map(function(r) {
              var key = r.method + ':' + r.url + ':' + r.body;
              var keyNoBody = r.method + ':' + r.url;
              if (__prefetched[key]) return __prefetched[key];
              if (__prefetched[keyNoBody]) return __prefetched[keyNoBody];
              throw new Error('No prefetched batch response for: ' + r.method + ' ' + r.url);
            });
          }
        };
      };
    `, this.sandbox, { timeout: 1000 });

    try {
      const result = vm.runInContext(`
        (function() {
          try {
            var channel = source.getChannel(${JSON.stringify(url)});
            return channel;
          } catch(e) {
            if (e.name === 'UnavailableException') return null;
            return { __error: e.message || String(e) };
          }
        })()
      `, this.sandbox, { timeout: this.config.cpuTimeoutMs ?? 10000 });

      if (result && typeof result === 'object' && '__error' in result) {
        process.stderr.write(`[runtime:${this.config.sourceKey}] getChannel error: ${(result as Record<string, string>).__error}\n`);
        return null;
      }

      return result as Record<string, unknown> | null;
    } catch (err) {
      process.stderr.write(`[runtime:${this.config.sourceKey}] Execution error: ${err}\n`);
      return null;
    }
  }

  dispose(): void {
    this.initialized = false;
  }

  /**
   * Create a DOM wrapper object that mimics what plugins expect from domParser.
   * Uses cheerio under the hood.
   */
  private createDomWrapper(html: string): unknown {
    const $ = cheerio.load(html);
    return createNodeWrapper($, $.root() as cheerio.Cheerio<AnyNode>);
  }
}

// ---- Cheerio-based DOM wrapper ----

function createNodeWrapper(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
): Record<string, unknown> {
  const wrapper: Record<string, unknown> = {
    querySelectorAll(selector: string): Record<string, unknown>[] {
      const results: Record<string, unknown>[] = [];
      el.find(selector).each((_, e) => {
        results.push(createNodeWrapper($, $(e)));
      });
      return results;
    },

    querySelector(selector: string): Record<string, unknown> | null {
      const found = el.find(selector).first();
      if (found.length === 0) return null;
      return createNodeWrapper($, found);
    },

    getElementsByClassName(className: string): Record<string, unknown>[] {
      return (wrapper.querySelectorAll as (s: string) => Record<string, unknown>[])('.' + className);
    },

    getElementsByTagName(tagName: string): Record<string, unknown>[] {
      return (wrapper.querySelectorAll as (s: string) => Record<string, unknown>[])(tagName);
    },

    getAttribute(name: string): string | null {
      return el.attr(name) ?? null;
    },

    get textContent(): string {
      return el.text();
    },

    get innerHTML(): string {
      return el.html() ?? '';
    },

    get tagName(): string {
      const raw = el.get(0);
      if (!raw || raw.type !== 'tag') return '';
      return raw.tagName?.toUpperCase() || '';
    },

    get childNodes(): Record<string, unknown>[] {
      const children: Record<string, unknown>[] = [];
      el.contents().each((_, child) => {
        children.push(createNodeWrapper($, $(child)));
      });
      return children;
    },

    get children(): Record<string, unknown>[] {
      const result: Record<string, unknown>[] = [];
      el.children().each((_, child) => {
        result.push(createNodeWrapper($, $(child)));
      });
      return result;
    },

    get parentElement(): Record<string, unknown> | null {
      const parent = el.parent();
      if (parent.length === 0) return null;
      return createNodeWrapper($, parent);
    },

    get classList(): string[] {
      const cls = el.attr('class');
      return cls ? cls.split(/\s+/).filter(Boolean) : [];
    },

    get attributes(): Record<string, string> {
      const raw = el.get(0);
      if (!raw || raw.type !== 'tag') return {};
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.attribs)) {
        result[k] = String(v);
      }
      return result;
    },

    get length(): number {
      return el.length;
    },

    // Support iteration: for (const x of nodeList) { ... }
    [Symbol.iterator]() {
      let i = 0;
      const items = el.toArray().map((e) => createNodeWrapper($, $(e)));
      return {
        next: () =>
          i < items.length
            ? { value: items[i++], done: false }
            : { value: undefined, done: true },
      };
    },
  };

  return wrapper;
}
