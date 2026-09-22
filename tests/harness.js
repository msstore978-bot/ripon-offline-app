/**
 * TEST HARNESS
 *
 * Loads Code.gs + Barcode.gs and, when requested, Api.gs
 * inside an isolated Node.js VM using the repository's GAS shim.
 *
 * Works in GitHub Actions and locally.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const { createShim } = require('../web/js/gas-shim.js');

const root = process.env.GITHUB_WORKSPACE
  ? path.resolve(process.env.GITHUB_WORKSPACE)
  : path.resolve(__dirname, '..');

const APPS_SCRIPT_DIR = path.join(root, 'apps-script');
const BARCODE_FILE = path.join(APPS_SCRIPT_DIR, 'Barcode.gs');
const CODE_FILE = path.join(APPS_SCRIPT_DIR, 'Code.gs');
const API_FILE = path.join(APPS_SCRIPT_DIR, 'Api.gs');

function requireFile(filePath, label = filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error([
      '',
      '============================================================',
      'REQUIRED FILE NOT FOUND',
      '============================================================',
      `File: ${label}`,
      `Path: ${filePath}`,
      `Repository root: ${root}`,
      `Current directory: ${process.cwd()}`,
      '============================================================',
      ''
    ].join('\n'));
  }
}

function readScript(filePath) {
  requireFile(filePath);
  return fs.readFileSync(filePath, 'utf8');
}

requireFile(BARCODE_FILE, 'apps-script/Barcode.gs');
requireFile(CODE_FILE, 'apps-script/Code.gs');

function makeEnv(opts = {}) {
  const store = opts.store || {
    tables: {},
    props: {},
    cache: {},
    files: {}
  };

  if (opts.sheet1 && !store.tables.Sheet1) {
    store.tables.Sheet1 = [];
  }

  const shim = createShim(store);

  const clock = {
    now: new Date(opts.now || '2026-09-19T10:00:00Z')
  };

  const FakeDate = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now.getTime()]));
    }

    static now() {
      return clock.now.getTime();
    }
  };

  const g = Object.assign(
    {
      console,
      Date: FakeDate
    },
    shim.globals
  );

  if (opts.server) {
    g.ContentService = {
      MimeType: { JSON: 'JSON' },

      createTextOutput(text) {
        return {
          text,
          setMimeType() {
            return this;
          },
          getContent() {
            return text;
          }
        };
      }
    };

    g.Utilities = Object.assign({}, g.Utilities, {
      computeDigest(_algorithm, value) {
        return Array.from(
          crypto.createHash('md5').update(String(value)).digest()
        ).map(byte => byte > 127 ? byte - 256 : byte);
      },

      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' }
    });

    g.DriveApp = Object.assign({}, g.DriveApp, {
      getFileById(id) {
        return {
          setTrashed() {
            delete store.files[id];
          },

          getBlob() {
            const file = store.files[id];

            if (!file) {
              throw new Error('Drive file not found: ' + id);
            }

            return {
              getContentType: () => file.mime,
              getBytes: () => file.bytes
            };
          }
        };
      }
    });
  }

  const ctx = vm.createContext(g);

  vm.runInContext(readScript(BARCODE_FILE), ctx, {
    filename: BARCODE_FILE
  });

  vm.runInContext(readScript(CODE_FILE), ctx, {
    filename: CODE_FILE
  });

  if (opts.server) {
    requireFile(API_FILE, 'apps-script/Api.gs');

    vm.runInContext(readScript(API_FILE), ctx, {
      filename: API_FILE
    });
  }

  function call(fn, ...args) {
    const target = vm.runInContext(fn, ctx);

    if (typeof target !== 'function') {
      throw new Error(`Test function "${fn}" was not found.`);
    }

    return target(...args);
  }

  return {
    ctx,
    store,
    call,
    clock,
    setNow(iso) {
      const next = new Date(iso);

      if (Number.isNaN(next.getTime())) {
        throw new Error(`Invalid test date: ${iso}`);
      }

      clock.now = next;
    },
    sheets: store.tables
  };
}

let fails = 0;
let passes = 0;

function ok(condition, message) {
  if (!condition) {
    fails++;
    console.log('FAIL:', message);
  } else {
    passes++;

    if (process.env.VERBOSE) {
      console.log('ok  :', message);
    }
  }
}

function eq(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  ok(
    actualJson === expectedJson,
    message +
      (actualJson === expectedJson
        ? ''
        : ` => ${actualJson} expected ${expectedJson}`)
  );
}

function done(name = 'TEST') {
  if (fails > 0) {
    console.log(`${name}: FAILED ${fails} test(s), ${passes} passed`);
    process.exitCode = 1;
    return false;
  }

  console.log(`${name}: ALL PASSED (${passes} checks)`);
  process.exitCode = 0;
  return true;
}

module.exports = {
  makeEnv,
  ok,
  eq,
  done
};
