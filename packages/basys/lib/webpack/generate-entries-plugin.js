const chokidar = require('chokidar');
const espree = require('espree');
const fs = require('fs-extra');
const glob = require('glob');
const nunjucks = require('nunjucks');
const path = require('path');
const pathToRegexp = require('path-to-regexp');
const {codeConfig} = require('../config');

class GenerateEntriesWebpackPlugin {
  constructor(config) {
    this.config = config;
  }

  apply(compiler) {
    this.generateEntries(true);

    if (this.config.env === 'dev') {
      // Re-generate webpack entries when .vue files inside src/ folder change
      chokidar
        .watch(this.vuePattern, {ignoreInitial: true})
        .on('add', () => this.generateEntries())
        .on('change', () => this.generateEntries())
        .on('unlink', filePath => {
          // Ignore deleting Vue components from other apps
          if (filePath in this.config.vueComponents) this.generateEntries();
        });
    }

    compiler.hooks.done.tap('GenerateEntriesWebpackPlugin', multiStats => {
      Array.prototype.push.apply(multiStats.stats[0].compilation.errors, this.errors);
    });
  }

  // BUG: accept optional location and save inside error
  error(filePath, message) {
    const err = new Error(message);
    err.file = path.relative(this.config.projectDir, filePath);
    this.errors.push(err);
  }

  // BUG: Perform validation of component options, at least the ones that affect whether and how they are used.
  //      Warn if component names are not unique or missing.
  generateEntries(init) {
    nunjucks.configure(path.join(__dirname, '..', 'templates'), {autoescape: false});
    this.errors = [];
    this.vuePattern = path.join(this.config.projectDir, 'src', '**', '*.vue');

    const vuePaths = glob.sync(this.vuePattern);
    this.config.vueComponents = {}; // {vuePath: info}
    for (const vuePath of vuePaths) {
      this.config.vueComponents[vuePath] = {};

      const content = fs.readFileSync(vuePath, 'utf8');
      const start = content.indexOf('<script>');
      const end = content.indexOf('</script>');
      if (start === -1 || end === -1 || start > end) {
        this.error(vuePath, `<script>...</script> block was not found`);
        continue;
      }

      let ast;
      try {
        ast = espree.parse(content.substring(start + 8, end), {
          range: false,
          loc: true,
          comment: false,
          attachComment: true,
          tokens: true,
          ecmaVersion: 8,
          sourceType: 'module',
          ecmaFeatures: {impliedStrict: true},
        });
      } catch (e) {
        continue;
      }

      const exportNode = ast.body.find(node => node.type === 'ExportDefaultDeclaration');
      if (!exportNode || exportNode.declaration.type !== 'ObjectExpression') {
        this.error(vuePath, 'Expected `export default { ... }` inside <script> block');
        continue;
      }

      const infoProp = exportNode.declaration.properties.find(
        node => node.key.type === 'Identifier' && node.key.name === 'info',
      );
      if (infoProp) {
        if (infoProp.value.type !== 'ObjectExpression') {
          this.error(vuePath, "'info' option must be an object");
          continue;
        }
        const props = infoProp.value.properties;

        const appsProp = props.find(
          node => node.key.type === 'Identifier' && node.key.name === 'apps',
        );
        if (appsProp) {
          if (appsProp.value.type !== 'ArrayExpression') {
            this.error(vuePath, "'info.apps' option must be an array of string literals");
            continue;
          }

          if (appsProp.value.elements.length > 0) {
            const apps = [];
            for (const appElem of appsProp.value.elements) {
              if (appElem.type !== 'Literal' || typeof appElem.value !== 'string') {
                this.error(vuePath, "All items of 'info.apps' option be string literals");
                continue;
              }
              apps.push(appElem.value);
            }

            if (!apps.includes(this.config.appName)) {
              delete this.config.vueComponents[vuePath];
              continue;
            }
          }
        }

        const pathProp = props.find(
          node => node.key.type === 'Identifier' && node.key.name === 'path',
        );
        if (pathProp) {
          if (pathProp.value.type !== 'Literal' || typeof pathProp.value.value !== 'string') {
            this.error(vuePath, "'info.path' option must be a string literal");
            continue;
          }

          if (!pathProp.value.value.startsWith('/')) {
            this.error(vuePath, "'info.path' option must start with '/'");
            continue;
          }

          this.config.vueComponents[vuePath].path = pathProp.value.value;
        }
      }
    }

    const entries = {};

    // Generate backend entry for web apps
    if (this.config.type === 'web') {
      const pagePaths = [];
      for (const vuePath in this.config.vueComponents) {
        const info = this.config.vueComponents[vuePath];
        if (info.path) {
          try {
            // We use the version 1.7.0 of path-to-regexp package, which is used in vue-router
            pagePaths.push(
              pathToRegexp(info.path, [], {sensitive: this.config.caseSensitive}).toString(),
            );
          } catch (e) {
            this.errors.push(new Error(`${vuePath} page path error: ${e.message}`));
            continue;
          }
        }
      }

      entries.backend = nunjucks.render('backend.js', {
        env: this.config.env,
        appName: this.config.appName,
        pagePaths,
        entry:
          this.config.backendEntry &&
          path.join(this.config.projectDir, 'src', this.config.backendEntry),
        conf: codeConfig(this.config),
      });
    }

    // BUG: for web app don't generate front-end bundle if there are no pages (what about mobile/desktop?)
    entries.frontend = nunjucks.render('frontend.js', {
      vueComponents: this.config.vueComponents,
      entry: this.config.entry && path.join(this.config.projectDir, 'src', this.config.entry),
      caseSensitive: !!this.config.caseSensitive,
    });

    for (const entryType in entries) {
      const entryPath = path.join(this.config.tempDir, `${entryType}-entry.js`);
      fs.writeFileSync(entryPath, entries[entryType]);

      if (init) {
        // A fix for the webpack-dev-server issue https://github.com/webpack/webpack-dev-server/issues/1208
        const time = new Date(Date.now() - 100000);
        fs.utimesSync(entryPath, time, time);
      }
    }
  }
}

module.exports = GenerateEntriesWebpackPlugin;
