/**
 * ============================================================
 * TEST HARNESS
 * ============================================================
 *
 * Code.gs + Barcode.gs + optional Api.gs
 * একটি isolated VM environment-এর মধ্যে চালায়।
 *
 * Google Apps Script services-এর পরিবর্তে
 * web/js/gas-shim.js ব্যবহার করা হয়।
 *
 * GitHub Actions এবং Local machine—দুই environment-এই
 * repository root সঠিকভাবে detect করার চেষ্টা করে।
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const { createShim } = require('../web/js/gas-shim.js');


// ============================================================
// REPOSITORY ROOT
// ============================================================

/*
 * GitHub Actions-এ:
 *
 *   GITHUB_WORKSPACE
 *
 * repository-এর absolute path দেয়।
 *
 * Local machine-এ:
 *
 *   __dirname/..
 *
 * ব্যবহার করা হবে।
 */

const root = process.env.GITHUB_WORKSPACE
  ? path.resolve(process.env.GITHUB_WORKSPACE)
  : path.resolve(__dirname, '..');


// ============================================================
// IMPORTANT FILE PATHS
// ============================================================

const APPS_SCRIPT_DIR = path.join(root, 'apps-script');

const BARCODE_FILE = path.join(
  APPS_SCRIPT_DIR,
  'Barcode.gs'
);

const CODE_FILE = path.join(
  APPS_SCRIPT_DIR,
  'Code.gs'
);

const API_FILE = path.join(
  APPS_SCRIPT_DIR,
  'Api.gs'
);


// ============================================================
// FILE VALIDATION
// ============================================================

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      [
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
      ].join('\n')
    );
  }
}


// Check required files before running VM.

requireFile(
  BARCODE_FILE,
  'apps-script/Barcode.gs'
);

requireFile(
  CODE_FILE,
  'apps-script/Code.gs'
);


// Api.gs is required only when server mode is used.
// Therefore it is checked inside makeEnv().


// ============================================================
// READ FILE
// ============================================================

function readScript(filePath) {
  requireFile(filePath, filePath);

  return fs.readFileSync(
    filePath,
    'utf8'
  );
}


// ============================================================
// MAKE TEST ENVIRONMENT
// ============================================================

function makeEnv(opts) {

  opts = opts || {};


  // ----------------------------------------------------------
  // Fake storage
  // ----------------------------------------------------------

  const store =
    opts.store ||
    {
      tables: {},
      props: {},
      cache: {},
      files: {}
    };


  // ----------------------------------------------------------
  // Optional Sheet1
  // ----------------------------------------------------------

  if (opts.sheet1) {
    store.tables['Sheet1'] = [];
  }


  // ----------------------------------------------------------
  // GAS Shim
  // ----------------------------------------------------------

  const shim = createShim(store);


  // ----------------------------------------------------------
  // Fake clock
  // ----------------------------------------------------------

  const clock = {
    now: new Date(
      opts.now ||
      '2026-09-19T10:00:00Z'
    )
  };


  // ----------------------------------------------------------
  // Fake Date
  // ----------------------------------------------------------

  const FakeDate = class extends Date {

    constructor(...args) {

      if (args.length === 0) {
        super(clock.now.getTime());
      } else {
        super(...args);
      }

    }

    static now() {
      return clock.now.getTime();
    }

  };


  // ----------------------------------------------------------
  // Global environment
  // ----------------------------------------------------------

  const g = Object.assign(
    {
      console,
      Date: FakeDate
    },
    shim.globals
  );


  // ==========================================================
  // SERVER ENVIRONMENT
  // ==========================================================

  if (opts.server) {

    // --------------------------------------------------------
    // ContentService
    // --------------------------------------------------------

    g.ContentService = {

      MimeType: {
        JSON: 'JSON'
      },

      createTextOutput: function (text) {

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


    // --------------------------------------------------------
    // Utilities
    // --------------------------------------------------------

    g.Utilities = Object.assign(
      {},
      g.Utilities,
      {

        computeDigest: (
          algorithm,
          value
        ) => {

          return Array.from(
            crypto
              .createHash('md5')
              .update(String(value))
              .digest()
          ).map(
            byte =>
              byte > 127
                ? byte - 256
                : byte
          );

        },

        DigestAlgorithm: {
          MD5: 'MD5'
        },

        Charset: {
          UTF_8: 'UTF_8'
        }

      }
    );


    // --------------------------------------------------------
    // DriveApp
    // --------------------------------------------------------

    g.DriveApp = Object.assign(
      {},
      g.DriveApp,
      {

        getFileById: id => ({

          setTrashed() {

            delete store.files[id];

          },

          getBlob() {

            const file =
              store.files[id];

            if (!file) {
              throw new Error(
                'Drive file not found: ' + id
              );
            }

            return {

              getContentType: () =>
                file.mime,

              getBytes: () =>
                file.bytes

            };

          }

        })

      }
    );

  }


  // ==========================================================
  // CREATE VM CONTEXT
  // ==========================================================

  const ctx = vm.createContext(g);


  // ==========================================================
  // LOAD BARCODE.GS
  // ==========================================================

  vm.runInContext(
    readScript(BARCODE_FILE),
    ctx,
    {
      filename: BARCODE_FILE
    }
  );


  // ==========================================================
  // LOAD CODE.GS
  // ==========================================================

  vm.runInContext(
    readScript(CODE_FILE),
    ctx,
    {
      filename: CODE_FILE
    }
  );


  // ==========================================================
  // LOAD API.GS WHEN SERVER MODE IS ENABLED
  // ==========================================================

  if (opts.server) {

    requireFile(
      API_FILE,
      'apps-script/Api.gs'
    );

    vm.runInContext(
      readScript(API_FILE),
      ctx,
      {
        filename: API_FILE
      }
    );

  }


  // ==========================================================
  // FUNCTION CALLER
  // ==========================================================

  const call = (
    fn,
    ...args
  ) => {

    const target =
      vm.runInContext(
        fn,
        ctx
      );

    if (typeof target !== 'function') {

      throw new Error(
        `Test function "${fn}" was not found.`
      );

    }

    return target(...args);

  };


  // ==========================================================
  // RETURN ENVIRONMENT
  // ==========================================================

  return {

    ctx,

    store,

    call,

    clock,

    setNow: iso => {

      clock.now =
        new Date(iso);

    },

    sheets: store.tables

  };

}


// ============================================================
// TEST RESULT COUNTERS
// ============================================================

let fails = 0;
let passes = 0;


// ============================================================
// ASSERTION
// ============================================================

function ok(condition, message) {

  if (!condition) {

    fails++;

    console.log(
      'FAIL:',
      message
    );

  } else {

    passes++;

    if (process.env.VERBOSE) {

      console.log(
        'ok  :',
        message
      );

    }

  }

}


// ============================================================
// EQUALITY ASSERTION
// ============================================================

function eq(
  actual,
  expected,
  message
) {

  const actualJson =
    JSON.stringify(actual);

  const expectedJson =
    JSON.stringify(expected);


  ok(
    actualJson === expectedJson,

    message +
      (
        actualJson === expectedJson
          ? ''
          :
          ' => ' +
          actualJson +
          ' expected ' +
          expectedJson
      )
  );

}


// ============================================================
// TEST COMPLETE
// ============================================================

function done(name) {

  const failed =
    fails > 0;


  if (failed) {

    console.log(
      `${name}: FAILED ${fails} test(s)`
    );

  } else {

    console.log(
      `${name}: ALL PASSED (${passes} checks)`
    );

  }


  process.exit(
    failed
      ? 1
      : 0
  );

}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  makeEnv,

  ok,

  eq,

  done

};
