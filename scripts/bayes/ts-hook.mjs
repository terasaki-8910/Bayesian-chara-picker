// Node の型の除去で src/ の TS を直接読むための解決フック(拡張子なしの相対 import に .ts を足す)。
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw e;
    }
  },
});
