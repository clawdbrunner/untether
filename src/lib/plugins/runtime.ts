import ivm from 'isolated-vm';

export class PluginSandbox {
  private isolate: ivm.Isolate;
  private context: ivm.Context;

  constructor(memoryLimitMb = 128) {
    this.isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
    this.context = this.isolate.createContextSync();
    this.setupGlobals();
  }

  private setupGlobals(): void {
    this.context.evalSync(`
      const atob = (s) => { throw new Error('atob: not implemented in sandbox'); };
      const btoa = (s) => { throw new Error('btoa: not implemented in sandbox'); };
      const IS_TESTING = false;
      const log = (...args) => {};
    `);
  }

  /**
   * Execute a parsing function in the sandbox.
   * The function receives `data` (the raw response) and must return structured results.
   */
  parse(parseCode: string, data: unknown, timeoutMs = 10000): unknown {
    const json = JSON.stringify(data);
    const code = `
      const data = ${json};
      ${parseCode}
    `;
    const script = this.isolate.compileScriptSync(code, { filename: 'plugin-parse.js' });
    return script.runSync(this.context, { timeout: timeoutMs });
  }

  /**
   * Parse HTML using sandbox evaluation.
   * The HTML string is injected and the parse code can operate on it.
   */
  parseHtml(parseCode: string, html: string, timeoutMs = 10000): unknown {
    const script = this.isolate.compileScriptSync(`
      const html = ${JSON.stringify(html)};
      ${parseCode}
    `, { filename: 'plugin-html-parse.js' });
    return script.runSync(this.context, { timeout: timeoutMs });
  }

  dispose(): void {
    this.isolate.dispose();
  }
}
