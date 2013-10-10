/*global context:true */
/*
Inject
Copyright 2011 LinkedIn

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an "AS
IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
express or implied.   See the License for the specific language
governing permissions and limitations under the License.
*/

/**
 * RequireContext is an instance object which provides the
 * CommonJS and AMD interfaces of require(string),
 * require(array, callback) ensure (require.ensure),
 * run (require.run), and define.
 * @file
**/
var RequireContext = Fiber.extend(function () {
  return {
    /**
     * Creates a new RequireContext
     * @constructs RequireContext
     * @param {String} id - the current module ID for this context
     * @param {String} path - the current module URL for this context
     * @public
     */
    init: function (id, path) {
      this.id = id || null;
      this.path = path || null;
    },

    /**
     * Log an operation for this context
     * @method RequireContext#log
     * @param {String} message - the message to log
     * @protected
     */
    log: function (message) {
      debugLog('RequireContext for ' + this.path, message);
    },

    /**
     * get the path associated with this context
     * @method RequireContext#getPath
     * @public
     * @returns {String} the path for the current context
     */
    getPath: function () {
      if (!userConfig.moduleRoot) {
        throw new Error('moduleRoot must be defined. Please use Inject.setModuleRoot()');
      }
      return this.path || userConfig.moduleRoot;
    },

    /**
     * get the ID associated with this context
     * @method RequireContext#getId
     * @public
     * @returns {String} the id of the current context
     */
    getId: function () {
      return this.id || '';
    },

    /**
     * The CommonJS and AMD require interface<br>
     * CommonJS: <strong>require(moduleId)</strong><br>
     * AMD: <strong>require(moduleList, callback)</strong>
     * @method RequireContext#require
     * @param {String|Array} moduleIdOrList - a string (CommonJS) or Array (AMD) of modules to include
     * @param {Function} callback - a callback (AMD) to run on completion
     * @public
     * @returns {Object|null} the object at the module ID (CommonJS) or null (AMD)
     * @see <a href="http://wiki.commonjs.org/wiki/Modules/1.0">http://wiki.commonjs.org/wiki/Modules/1.0</a>
     * @see <a href="https://github.com/amdjs/amdjs-api/wiki/require">https://github.com/amdjs/amdjs-api/wiki/require</a>
     */
    require: function (moduleIdOrList, callback) {
      var module;
      var identifier;
      var assignedModule;

      if (typeof(moduleIdOrList) === 'string') {
        this.log('CommonJS require(string) of ' + moduleIdOrList);
        if (/^[\d]+$/.test(moduleIdOrList)) {
          throw new Error('require() must be a string containing a-z, slash(/), dash(-), and dots(.)');
        }

        // try to get the module a couple different ways
        identifier = RulesEngine.resolveModule(moduleIdOrList, this.getId());
        module = Executor.getModule(identifier);
        if (module) {
          return module.exports;
        }
        else {
          throw new Error('module ' + moduleIdOrList + ' not found');
        }
      }

      // AMD require
      this.log('AMD require(Array) of ' + moduleIdOrList.join(', '));
      var resolved = [];
      this.ensure(moduleIdOrList, proxy(function (localRequire) {
        for (var i = 0, len = moduleIdOrList.length; i < len; i++) {
          switch(moduleIdOrList[i]) {
          case 'require':
            resolved.push(localRequire);
            break;
          case 'module':
          case 'exports':
            throw new Error('require(array, callback) doesn\'t create a module. You cannot use module/exports here');
          default:
            resolved.push(localRequire(moduleIdOrList[i]));
          }
        }
        callback.apply(context, resolved);
      }, this));
    },

    /**
     * the CommonJS require.ensure interface based on the async/a spec
     * @method RequireContext#ensure
     * @param {Array} moduleList - an array of modules to load
     * @param {Function} callback - a callback to run when all modules are loaded
     * @public
     * @see <a href="http://wiki.commonjs.org/wiki/Modules/Async/A">http://wiki.commonjs.org/wiki/Modules/Async/A</a>
     */
    ensure: function (moduleList, callback) {
      if (Object.prototype.toString.call(moduleList) !== '[object Array]') {
        throw new Error('require.ensure() must take an Array as the first argument');
      }

      this.log('CommonJS require.ensure(array) of ' + moduleList.join(', '));

      // strip builtins (CommonJS doesn't download or make these available)
      moduleList = Analyzer.stripBuiltins(moduleList);

      var require = proxy(this.require, this);
      this.process(moduleList, function(root) {
        if (typeof callback == 'function') {
          callback(require);
        }
      });
    },

    /**
     * Run a module as a one-time approach. This is common verbage
     * in many AMD based systems
     * @method RequireContext#run
     * @param {String} moduleId - the module ID to run
     * @public
     */
    run: function (moduleId) {
      this.log('AMD require.run(string) of ' + moduleId);
      this.ensure([moduleId]);
    },

    /**
     * Define a module with its arguments. Define has multiple signatures:
     * <ul>
     *  <li>define(id, dependencies, factory)</li>
     *  <li>define(id, factory)</li>
     *  <li>define(dependencies, factory)</li>
     *  <li>define(factory)</li>
     * </ul>
     * @method RequireContext#define
     * @param {string} id - if provided, the name of the module being defined
     * @param {Array} dependencies - if provided, an array of dependencies for this module
     * @param {Object|Function} factory - an object literal that defines the module or a function to run that will define the module
     * @public
     * @see <a href="https://github.com/amdjs/amdjs-api/wiki/AMD">https://github.com/amdjs/amdjs-api/wiki/AMD</a>
     */
    define: function () {
      var args = Array.prototype.slice.call(arguments, 0);
      var id = null;
      var dependencies = ['require', 'exports', 'module'];
      var dependenciesDeclared = false;
      var executionFunctionOrLiteral = {};
      var remainingDependencies = [];
      var resolvedDependencyList = [];
      var tempModuleId = null;

      // these are the various AMD interfaces and what they map to
      // we loop through the args by type and map them down into values
      // while not efficient, it makes this overloaed interface easier to
      // maintain
      var interfaces = {
        'string array object': ['id', 'dependencies', 'executionFunctionOrLiteral'],
        'string object':       ['id', 'executionFunctionOrLiteral'],
        'array object':        ['dependencies', 'executionFunctionOrLiteral'],
        'object':              ['executionFunctionOrLiteral']
      };
      var key = [];
      var value;
      var i;
      for (i = 0, len = args.length; i < len; i++) {
        if (Object.prototype.toString.apply(args[i]) === '[object Array]') {
          key.push('array');
        }
        else if (typeof(args[i]) === 'object' || typeof(args[i]) === 'function') {
          key.push('object');
        }
        else {
          key.push(typeof(args[i]));
        }
      }
      key = key.join(' ');

      if (!interfaces[key]) {
        throw new Error('You did not use an AMD compliant interface. Please check your define() calls');
      }

      key = interfaces[key];
      for (i = 0, len = key.length; i < len; i++) {
        value = args[i];
        switch (key[i]) {
        case 'id':
          id = value;
          break;
        case 'dependencies':
          dependencies = value;
          dependenciesDeclared = true;
          break;
        case 'executionFunctionOrLiteral':
          executionFunctionOrLiteral = value;
          break;
        }
      }

      // handle anonymous modules
      if (!id) {
        currentExecutingAMD = Executor.getCurrentExecutingAMD();
        if (currentExecutingAMD) {
          id = currentExecutingAMD.id;
        }
        else {
          throw new Error('Anonymous AMD module used, but it was not included as a dependency. This is most often caused by an anonymous define() from a script tag.');
        }
        this.log('AMD identified anonymous module as ' + id);
      }
      
      this.process(dependencies, function(root) {
        // all modules have been ran, now to deal with this guy's args
        var resolved = [];
        var deps = (dependenciesDeclared) ? dependencies : [];
        var require = InjectCore.createRequire(root.data.resolvedId, root.data.resolvedUrl);
        var module = Executor.createModule(root.data.resolvedId, root.data.resolvedUrl);
        var result;
        for (var i = 0, len = deps.length; i < len; i++) {
          switch(deps[i]) {
          case 'require':
            resolved.push(require);
            break;
          case 'module':
            resolved.push(module);
            break;
          case 'exports':
            resolved.push(module.exports);
            break;
          default:
            resolved.push(require(deps[i]));
          }
        }
        if (typeof factory === 'function') {
          result = factory.apply(module, resolved);
          if (result) {
            module.exports = results;
          }
        }
        else if (typeof factory === 'object') {
          module.exports = factory;
        }
        module.amd = true;
        Executor.setModule(module.id, module);
      });
    },
    
    /**
     * Process all the modules selected by the various CJS / AMD interfaces
     * builds a tree to handle the dependency download and execution
     * upon completion, calls the provided callback, returning the root node
     * @method RequireContext#process
     * @param {Array} dependencies - an array of dependencies to process
     * @param {Function} callback - a function called when the module tree is downloaded and processed
     * @private
     */
    process: function(dependencies, callback) {
      var root = new TreeNode();
      var count = dependencies.length;
      var node;
      var runner;
      var runners = [];
      var resolveCount = function() {
        if (count === 0 || --count === 0) {
          runner = new TreeRunner(root);
          runner.execute(function() {
            callback(root);
          });
        }
      };
      root.data.originalId = this.id;
      root.data.resolvedId = this.id;
      root.data.resolvedUrl = this.path;
      
      if (dependencies.length) {
        for (i = 0, len = dependencies.length; i < len; i++) {
          if (BUILTINS[dependencies[i]]) {
            count--;
            resolveCount();
          }
          else {
            node = new TreeNode();
            node.data.originalId = dependencies[i];
            runner = new TreeRunner(node);
            runners.push(runner);
            root.addChild(node);
            runner.download(resolveCount);
          }
        }
      }
      else {
        resolveCount();
      }
    }
  };
});

RequireContext = RequireContext;