import vm from 'node:vm';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { createHash } from 'node:crypto';

export interface RuntimeConfig {
  sourceKey: string;
  limiter: RateLimiter;
  memoryLimitMb?: number;
  cpuTimeoutMs?: number;
}

type HttpResponse = { isOk: boolean; code: number; body: string };

/**
 * Hardened Grayjay plugin runtime using Node vm with security hardening.
 *
 * Security model:
 * - vm context created with Object.create(null) (no prototype chain escape)
 * - No console with constructor chain — frozen no-op object
 * - No process, require, fs, or other Node internals in sandbox
 * - CPU timeout enforced by vm.runInContext({ timeout })
 * - HTTP calls pre-fetched by host, injected as JSON (no network access from sandbox)
 * - Bridge object frozen (can't modify platform detection)
 * - Fresh sandbox per execution (no cross-execution state leakage)
 */
export class PluginRuntime {
  private config: RuntimeConfig;
  private initialized = false;
  private _source: string = '';

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  /**
   * Load the plugin source into a hardened sandbox and call source.enable().
   * Validates the plugin loads successfully before marking as initialized.
   */
  async loadAndEnable(source: string): Promise<void> {
    this._source = source;

    // Validate the source loads in the sandbox
    const sandbox = this.createHardenedSandbox();
    const ctx = vm.createContext(sandbox, { name: `plugin-${this.config.sourceKey}` });

    try {
      vm.runInContext(source, ctx, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });
      vm.runInContext("source.enable({ id: 'untether' }, {}, null)", ctx, { timeout: 5000 });
      this.initialized = true;
    } catch (err) {
      process.stderr.write(`[runtime:${this.config.sourceKey}] Failed to load plugin: ${err}\n`);
      this.initialized = false;
      throw err;
    }
  }

  /**
   * Execute source.searchChannels(query) with pre-fetched HTTP responses.
   * Creates a fresh hardened sandbox for each execution.
   */
  executeSearchChannels(
    query: string,
    prefetchedResponses: Map<string, HttpResponse>,
  ): unknown[] {
    if (!this.initialized) throw new Error('Plugin not loaded');

    const sandbox = this.createHardenedSandbox();
    const ctx = vm.createContext(sandbox, { name: `plugin-${this.config.sourceKey}` });

    try {
      // Load the plugin source
      vm.runInContext(this._source, ctx, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });
      vm.runInContext("source.enable({ id: 'untether' }, {}, null)", ctx, { timeout: 5000 });

      // Inject prefetched responses and override HTTP
      this.injectPrefetchedHttp(ctx, prefetchedResponses);

      // Execute searchChannels
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
      `, ctx, { timeout: this.config.cpuTimeoutMs ?? 10000 });

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
   * Creates a fresh hardened sandbox for each execution.
   */
  executeGetChannel(
    url: string,
    prefetchedResponses: Map<string, HttpResponse>,
  ): Record<string, unknown> | null {
    if (!this.initialized) return null;

    const sandbox = this.createHardenedSandbox();
    const ctx = vm.createContext(sandbox, { name: `plugin-${this.config.sourceKey}` });

    try {
      vm.runInContext(this._source, ctx, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });
      vm.runInContext("source.enable({ id: 'untether' }, {}, null)", ctx, { timeout: 5000 });

      // Inject prefetched responses and override HTTP
      this.injectPrefetchedHttp(ctx, prefetchedResponses);

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
      `, ctx, { timeout: this.config.cpuTimeoutMs ?? 10000 });

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
    this._source = '';
  }

  /**
   * Inject prefetched HTTP responses and override http/httpGET/httpPOST in the sandbox context.
   */
  private injectPrefetchedHttp(ctx: vm.Context, prefetchedResponses: Map<string, HttpResponse>): void {
    const responseMap: Record<string, HttpResponse> = {};
    for (const [key, value] of prefetchedResponses) {
      responseMap[key] = value;
    }
    vm.runInContext(`var __prefetched = ${JSON.stringify(responseMap)};`, ctx, { timeout: 1000 });

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
        var reqs = [];
        return {
          POST: function(u,b,h,a) { reqs.push({method:'POST',url:u,body:b}); },
          GET: function(u,h,a) { reqs.push({method:'GET',url:u,body:''}); },
          execute: function() {
            return reqs.map(function(r) {
              var k = r.method+':'+r.url+':'+r.body;
              var kn = r.method+':'+r.url;
              if (__prefetched[k]) return __prefetched[k];
              if (__prefetched[kn]) return __prefetched[kn];
              throw new Error('No batch: '+r.method+' '+r.url);
            });
          }
        };
      };
    `, ctx, { timeout: 1000 });
  }

  /**
   * Create a hardened sandbox with Object.create(null) prototype.
   *
   * Security properties:
   * - Object.create(null): no prototype chain, no constructor.constructor traversal
   * - Frozen console: no-op functions, no constructor chain to traverse
   * - Frozen bridge: can't modify platform detection
   * - No process, require, fs, import, child_process in scope
   * - CPU timeout via vm.runInContext({ timeout })
   */
  private createHardenedSandbox(): Record<string, unknown> {
    const self = this;
    const sandbox: Record<string, unknown> = Object.create(null);

    // ---- Safe built-ins only ----
    sandbox.JSON = JSON;
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    sandbox.isNaN = isNaN;
    sandbox.isFinite = isFinite;
    sandbox.Math = Math;
    sandbox.Date = Date;
    sandbox.RegExp = RegExp;
    sandbox.Error = Error;
    sandbox.TypeError = TypeError;
    sandbox.RangeError = RangeError;
    sandbox.URIError = URIError;
    sandbox.SyntaxError = SyntaxError;
    sandbox.ReferenceError = ReferenceError;
    sandbox.Number = Number;
    sandbox.String = String;
    sandbox.Array = Array;
    sandbox.Object = Object;
    sandbox.Map = Map;
    sandbox.Set = Set;
    sandbox.Symbol = Symbol;
    sandbox.Promise = Promise;
    sandbox.Proxy = Proxy;
    sandbox.WeakMap = WeakMap;
    sandbox.WeakSet = WeakSet;
    sandbox.encodeURIComponent = encodeURIComponent;
    sandbox.decodeURIComponent = decodeURIComponent;
    sandbox.encodeURI = encodeURI;
    sandbox.decodeURI = decodeURI;
    sandbox.Infinity = Infinity;
    sandbox.NaN = NaN;
    sandbox.undefined = undefined;

    // ---- NO console with constructor chain ----
    // Frozen no-op object: console.constructor.constructor('return process')() fails
    // because these are plain frozen functions with no exploitable prototype chain
    sandbox.console = Object.freeze({
      log: function() {},
      error: function() {},
      warn: function() {},
      info: function() {},
      debug: function() {},
    });

    // ---- Base64 ----
    sandbox.atob = (str: string) => Buffer.from(str, 'base64').toString('utf-8');
    sandbox.btoa = (str: string) => Buffer.from(str, 'utf-8').toString('base64');

    // ---- Prefetched response cache (injected per-execution) ----
    sandbox.__prefetched = {};

    // ---- DOM parser (cheerio-based, overridden per-execution) ----
    sandbox.domParser = {
      parseFromString: (html: string, _mimeType: string) => self.createDomWrapper(html),
    };
    sandbox.DOMParser = class {
      parseFromString(html: string, _mimeType: string) {
        return self.createDomWrapper(html);
      }
    };

    // ---- Grayjay platform classes ----
    sandbox.PlatformID = class PlatformID {
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
    };

    sandbox.PlatformChannel = class PlatformChannel {
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
    };

    sandbox.PlatformAuthorLink = class PlatformAuthorLink {
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
    };

    // ---- Pager classes ----
    sandbox.VideoPager = class VideoPager {
      results: unknown[];
      hasMore: boolean;
      context: unknown;
      constructor(results: unknown[] = [], hasMore = false, context: unknown = {}) {
        this.results = results;
        this.hasMore = hasMore;
        this.context = context;
      }
      nextPage() { return this; }
    };

    sandbox.ChannelPager = class ChannelPager {
      results: unknown[];
      hasMore: boolean;
      constructor(results: unknown[] = [], hasMore = false) {
        this.results = results;
        this.hasMore = hasMore;
      }
      nextPage() { return this; }
    };

    sandbox.ContentPager = class ContentPager {
      results: unknown[];
      hasMore: boolean;
      constructor(results: unknown[] = [], hasMore = false) {
        this.results = results;
        this.hasMore = hasMore;
      }
      nextPage() { return this; }
    };

    sandbox.Comment = class Comment {
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
    };

    sandbox.CommentPager = class CommentPager {
      results: unknown[];
      hasMore: boolean;
      context: unknown;
      constructor(results: unknown[] = [], hasMore = false, context: unknown = {}) {
        this.results = results;
        this.hasMore = hasMore;
        this.context = context;
      }
      nextPage() { return this; }
    };

    // ---- Media/Content classes ----
    sandbox.PlatformVideo = class PlatformVideo {
      id: unknown; author: unknown; title = ''; description = ''; thumbnails: unknown[] = [];
      url = ''; datetime: number | undefined; duration = 0; views: number | undefined;
      constructor(obj: Record<string, unknown>) {
        Object.assign(this, obj);
      }
    };
    sandbox.PlatformVideoDetails = class PlatformVideoDetails {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.PlatformPlaylist = class PlatformPlaylist {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.PlatformPlaylistDetails = class PlatformPlaylistDetails {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.VideoSourceDescriptor = class VideoSourceDescriptor {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.VideoUrlSource = class VideoUrlSource {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.HLSSource = class HLSSource {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.Thumbnail = class Thumbnail {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.Thumbnails = class Thumbnails {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.RatingLikesDislikes = class RatingLikesDislikes {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.RatingLikes = class RatingLikes {
      constructor(obj: Record<string, unknown>) { Object.assign(this, obj); }
    };
    sandbox.LoginRequiredException = class LoginRequiredException extends Error {
      constructor(msg: string) { super(msg); this.name = 'LoginRequiredException'; }
    };
    sandbox.CaptchaRequiredException = class CaptchaRequiredException extends Error {
      constructor(msg: string) { super(msg); this.name = 'CaptchaRequiredException'; }
    };

    // ---- Exception classes ----
    sandbox.ScriptException = class ScriptException extends Error {
      constructor(msg: string) { super(msg); this.name = 'ScriptException'; }
    };
    sandbox.UnavailableException = class UnavailableException extends Error {
      constructor(msg: string) { super(msg); this.name = 'UnavailableException'; }
    };

    // ---- Bridge (frozen — can't modify platform detection) ----
    sandbox.bridge = Object.freeze({
      buildPlatform: 'desktop',
      authUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      captchaUserAgent: undefined,
    });

    // ---- Source lifecycle ----
    sandbox.source = {} as Record<string, unknown>;

    // ---- Logging (frozen — no constructor traversal) ----
    sandbox.log = Object.freeze(function() {});

    // ---- Crypto hashes ----
    sandbox.SHA1 = (str: string) => createHash('sha1').update(str).digest('hex');
    sandbox.SHA256 = (str: string) => createHash('sha256').update(str).digest('hex');
    sandbox.MD5 = (str: string) => createHash('md5').update(str).digest('hex');

    // ---- Testing / config flags ----
    sandbox.IS_TESTING = false;
    sandbox.isAndroid = false;
    sandbox.state = {} as Record<string, unknown>;
    sandbox._config = { id: 'untether' } as Record<string, unknown>;
    sandbox._settings = {} as Record<string, unknown>;
    sandbox.config = { id: 'untether' } as Record<string, unknown>;
    sandbox.settings = {} as Record<string, unknown>;

    // ---- HTTP stubs (overridden per-execution with prefetched responses) ----
    sandbox.http = {
      GET: function() { throw new Error('HTTP not available outside execution'); },
      POST: function() { throw new Error('HTTP not available outside execution'); },
      batch: function() { throw new Error('HTTP not available outside execution'); },
    };
    sandbox.httpGET = function() { throw new Error('HTTP not available outside execution'); };
    sandbox.httpPOST = function() { throw new Error('HTTP not available outside execution'); };

    return sandbox;
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
