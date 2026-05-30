import ivm from 'isolated-vm';
import { createHash } from 'node:crypto';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';

export interface RuntimeConfig {
  sourceKey: string;
  limiter: RateLimiter;
  memoryLimitMb?: number;
  cpuTimeoutMs?: number;
}

type HttpResponse = { isOk: boolean; code: number; body: string };

/**
 * Grayjay plugin runtime using isolated-vm.
 *
 * Security: isolated-vm creates a separate V8 isolate with no shared object space.
 * - No prototype chain escape (separate heap)
 * - No process/require/fs access (not in scope)
 * - Memory limit enforced by V8 (128MB default)
 * - CPU timeout enforced by ivm
 * - Host functions via ivm.Reference — sandbox cannot traverse back
 * - All data transfer via primitives (strings) — no object sharing
 */
export class PluginRuntime {
  private config: RuntimeConfig;
  private isolate: ivm.Isolate | null = null;
  private initialized = false;
  private _source: string = '';

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  /**
   * Load the plugin source into a fresh isolate and call source.enable().
   */
  async loadAndEnable(source: string): Promise<void> {
    this._source = source;

    try {
      const { isolate, context } = this.createIsolate();

      this.setupSandboxGlobals(context);

      context.evalSync(source, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });

      context.evalSync("source.enable({ id: 'untether' }, {}, null)", { timeout: 5000 });

      this.isolate = isolate;
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
    if (!this.initialized || !this.isolate) throw new Error('Plugin not loaded');

    const context = this.isolate.createContextSync();
    this.setupSandboxGlobals(context);

    try {
      context.evalSync(this._source, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });
      context.evalSync("source.enable({ id: 'untether' }, {}, null)", { timeout: 5000 });

      this.injectPrefetchedHttp(context, prefetchedResponses);

      const result = context.evalSync(`
        (function() {
          try {
            var pager = source.searchChannels(${JSON.stringify(query)});
            if (pager && pager.results) return JSON.stringify(pager.results);
            if (Array.isArray(pager)) return JSON.stringify(pager);
            return '[]';
          } catch(e) {
            return JSON.stringify({ __error: e.message || String(e) });
          }
        })()
      `, { timeout: this.config.cpuTimeoutMs ?? 10000 });

      const parsed = JSON.parse(result as string);
      if (parsed && typeof parsed === 'object' && '__error' in parsed) {
        process.stderr.write(`[runtime:${this.config.sourceKey}] searchChannels error: ${parsed.__error}\n`);
        return [];
      }

      return Array.isArray(parsed) ? parsed : [];
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
    if (!this.initialized || !this.isolate) return null;

    const context = this.isolate.createContextSync();
    this.setupSandboxGlobals(context);

    try {
      context.evalSync(this._source, {
        timeout: this.config.cpuTimeoutMs ?? 10000,
        filename: `plugin-${this.config.sourceKey}.js`,
      });
      context.evalSync("source.enable({ id: 'untether' }, {}, null)", { timeout: 5000 });

      this.injectPrefetchedHttp(context, prefetchedResponses);

      const result = context.evalSync(`
        (function() {
          try {
            var channel = source.getChannel(${JSON.stringify(url)});
            if (!channel) return 'null';
            return JSON.stringify(channel);
          } catch(e) {
            if (e.name === 'UnavailableException') return 'null';
            return JSON.stringify({ __error: e.message || String(e) });
          }
        })()
      `, { timeout: this.config.cpuTimeoutMs ?? 10000 });

      if (result === 'null') return null;

      const parsed = JSON.parse(result as string);
      if (parsed && typeof parsed === 'object' && '__error' in parsed) {
        process.stderr.write(`[runtime:${this.config.sourceKey}] getChannel error: ${parsed.__error}\n`);
        return null;
      }

      return parsed;
    } catch (err) {
      process.stderr.write(`[runtime:${this.config.sourceKey}] Execution error: ${err}\n`);
      return null;
    }
  }

  dispose(): void {
    this.isolate?.dispose();
    this.isolate = null;
    this.initialized = false;
    this._source = '';
  }

  private createIsolate(): { isolate: ivm.Isolate; context: ivm.Context } {
    const isolate = new ivm.Isolate({ memoryLimit: this.config.memoryLimitMb ?? 128 });
    const context = isolate.createContextSync();
    return { isolate, context };
  }

  /**
   * Inject prefetched HTTP responses and set up HTTP bridge via ivm.Reference.
   */
  private injectPrefetchedHttp(context: ivm.Context, prefetchedResponses: Map<string, HttpResponse>): void {
    const prefetchedMap: Record<string, string> = {};
    for (const [key, value] of prefetchedResponses) {
      prefetchedMap[key] = JSON.stringify(value);
    }

    const httpFn = new ivm.Reference(function (method: string, url: string, body: string): string {
      const key = method + ':' + url + ':' + (body || '');
      const keyNoBody = method + ':' + url;
      if (prefetchedMap[key]) return prefetchedMap[key];
      if (prefetchedMap[keyNoBody]) return prefetchedMap[keyNoBody];
      return JSON.stringify({ isOk: false, code: 0, body: '' });
    });

    context.global.setSync('__httpRequest', httpFn);

    context.evalSync(`
      var httpPOST = function(url, body, headers, useAuth) {
        return JSON.parse(__httpRequest.applySync(undefined, ['POST', url, body || '']));
      };
      var httpGET = function(urlOrObj) {
        var url = typeof urlOrObj === 'object' ? urlOrObj.url : urlOrObj;
        return JSON.parse(__httpRequest.applySync(undefined, ['GET', url, '']));
      };
      var http = {
        POST: function(u,b,h,a) { return httpPOST(u,b,h,a); },
        GET: function(u,h,a) { return httpGET(u); },
        batch: function() {
          var reqs = [];
          return {
            POST: function(u,b,h,a) { reqs.push({method:'POST',url:u,body:b}); },
            GET: function(u,h,a) { reqs.push({method:'GET',url:u,body:''}); },
            execute: function() {
              return reqs.map(function(r) {
                return JSON.parse(__httpRequest.applySync(undefined, [r.method, r.url, r.body || '']));
              });
            }
          };
        }
      };
    `, { timeout: 1000 });
  }

  /**
   * Set up sandbox globals in an isolated-vm context.
   *
   * All classes and values are defined inside the sandbox via evalSync.
   * Host functions (atob, btoa, crypto) are bridged via ivm.Reference.
   *
   * Security: isolated-vm creates a separate V8 heap. The sandbox
   * cannot access the host's objects, constructors, or process.
   */
  private setupSandboxGlobals(context: ivm.Context): void {
    context.evalSync(`
      // No-op console
      var console = { log: function(){}, error: function(){}, warn: function(){}, info: function(){}, debug: function(){} };

      // Logging
      var log = function(){};

      // Flags
      var IS_TESTING = false;
      var isAndroid = false;

      // Bridge
      var bridge = { buildPlatform: 'desktop', authUserAgent: 'Mozilla/5.0', captchaUserAgent: undefined };

      // Config/state
      var _config = { id: 'untether' };
      var _settings = {};
      var config = { id: 'untether' };
      var settings = {};
      var state = {};

      // Platform classes
      var PlatformID = function(platform, id, pluginId, claimType, claimFieldType) {
        this.platform = platform; this.id = id; this.pluginId = pluginId;
        this.claimType = claimType; this.claimFieldType = claimFieldType;
      };
      var PlatformChannel = function(o) {
        this.id = o.id; this.name = o.name || ''; this.thumbnail = o.thumbnail || '';
        this.banner = o.banner || ''; this.subscribers = o.subscribers;
        this.description = o.description || ''; this.url = o.url || '';
        this.links = o.links || {};
      };
      var PlatformAuthorLink = function(id, name, url, thumbnail, subscribers) {
        this.id = id; this.name = name; this.url = url;
        this.thumbnail = thumbnail; this.subscribers = subscribers;
      };
      var PlatformVideo = function(o) { Object.assign(this, o); };
      var PlatformVideoDetails = function(o) { Object.assign(this, o); };
      var PlatformPlaylist = function(o) { Object.assign(this, o); };
      var PlatformPlaylistDetails = function(o) { Object.assign(this, o); };
      var VideoSourceDescriptor = function(o) { Object.assign(this, o); };
      var VideoUrlSource = function(o) { Object.assign(this, o); };
      var HLSSource = function(o) { Object.assign(this, o); };
      var Thumbnail = function(o) { Object.assign(this, o); };
      var Thumbnails = function(o) { Object.assign(this, o); };
      var RatingLikesDislikes = function(o) { Object.assign(this, o); };
      var RatingLikes = function(o) { Object.assign(this, o); };
      var LoginRequiredException = function(m) { this.message = m; this.name = 'LoginRequiredException'; };
      var CaptchaRequiredException = function(m) { this.message = m; this.name = 'CaptchaRequiredException'; };

      // Pager classes
      var VideoPager = function(results, hasMore, context) {
        this.results = results || []; this.hasMore = hasMore || false; this.context = context || {};
      };
      VideoPager.prototype.nextPage = function() { return this; };
      var ChannelPager = function(results, hasMore) {
        this.results = results || []; this.hasMore = hasMore || false;
      };
      ChannelPager.prototype.nextPage = function() { return this; };
      var ContentPager = function(results, hasMore) {
        this.results = results || []; this.hasMore = hasMore || false;
      };
      ContentPager.prototype.nextPage = function() { return this; };
      var CommentPager = function(results, hasMore, context) {
        this.results = results || []; this.hasMore = hasMore || false; this.context = context || {};
      };
      CommentPager.prototype.nextPage = function() { return this; };
      var Comment = function(o) {
        this.contextUrl = o.contextUrl || ''; this.author = o.author;
        this.message = o.message || ''; this.rating = o.rating;
        this.date = o.date || 0; this.replyCount = o.replyCount || 0;
        this.context = o.context;
      };

      // Exception classes
      var ScriptException = function(msg) { this.message = msg; this.name = 'ScriptException'; };
      ScriptException.prototype = Object.create(Error.prototype);
      var UnavailableException = function(msg) { this.message = msg; this.name = 'UnavailableException'; };
      UnavailableException.prototype = Object.create(Error.prototype);

      // Source lifecycle
      var source = {};

      // HTTP stubs (overridden per-execution with prefetched responses)
      var httpGET = function() { throw new Error('HTTP not available outside execution'); };
      var httpPOST = function() { throw new Error('HTTP not available outside execution'); };
      var http = {
        GET: function() { throw new Error('HTTP not available outside execution'); },
        POST: function() { throw new Error('HTTP not available outside execution'); },
        batch: function() { throw new Error('HTTP not available outside execution'); }
      };
    `, { timeout: 5000 });

    // Set up atob/btoa as host functions (Buffer isn't available in the sandbox)
    const atobFn = new ivm.Reference(function (str: string): string {
      return Buffer.from(str, 'base64').toString('utf-8');
    });
    const btoaFn = new ivm.Reference(function (str: string): string {
      return Buffer.from(str, 'utf-8').toString('base64');
    });
    context.global.setSync('__atob', atobFn);
    context.global.setSync('__btoa', btoaFn);
    context.evalSync('var atob = function(s) { return __atob.applySync(undefined, [s]); }; var btoa = function(s) { return __btoa.applySync(undefined, [s]); };', { timeout: 1000 });

    // Set up crypto hashes as host functions
    const sha256Fn = new ivm.Reference(function (s: string): string {
      return createHash('sha256').update(s).digest('hex');
    });
    const sha1Fn = new ivm.Reference(function (s: string): string {
      return createHash('sha1').update(s).digest('hex');
    });
    const md5Fn = new ivm.Reference(function (s: string): string {
      return createHash('md5').update(s).digest('hex');
    });
    context.global.setSync('__sha256', sha256Fn);
    context.global.setSync('__sha1', sha1Fn);
    context.global.setSync('__md5', md5Fn);
    context.evalSync('var SHA256 = function(s) { return __sha256.applySync(undefined, [s]); }; var SHA1 = function(s) { return __sha1.applySync(undefined, [s]); }; var MD5 = function(s) { return __md5.applySync(undefined, [s]); };', { timeout: 1000 });
  }
}
