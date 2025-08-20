import {
  parseAnnotations,
  annotate
} from './annotation.js';

import {
  isArray,
  hasOwnProp
} from './util.js';

/**
 * @typedef { import('./index.js').ModuleDeclaration } ModuleDeclaration
 * @typedef { import('./index.js').ModuleDefinition } ModuleDefinition
 * @typedef { import('./index.js').InjectorContext } InjectorContext
 *
 * @typedef { import('./index.js').TypedDeclaration<any, any> } TypedDeclaration
 */

/**
 * Create a new injector with the given modules.
 * 依赖注入器类 - 用于管理模块和依赖注入
 *
 * @param {ModuleDefinition[]} modules - 模块定义数组
 * @param {InjectorContext} [_parent] - 父级注入器上下文
 */
export default function Injector(modules, _parent) {

  const parent = _parent || /** @type InjectorContext */ ({
    get: function(name, strict) {
      currentlyResolving.push(name);

      if (strict === false) {
        return null;
      } else {
        throw error(`No provider for "${ name }"!`);
      }
    }
  });

	// 1. 主要组件说明:
	// - currentlyResolving: 当前正在解析的依赖链
  // - providers: 服务提供者存储对象
	// - instances: 服务实例缓存

  const currentlyResolving = [];
  const providers = this._providers = Object.create(parent._providers || null);
  const instances = this._instances = Object.create(null);

  const self = instances.injector = this;

  /**
   * 创建一个错误对象，包含当前正在解析的依赖路径
   * 
   * @param {string} msg - 错误消息
   * @return {Error} 包含依赖解析路径的错误对象
   */
  const error = function(msg) {
    const stack = currentlyResolving.join(' -> ');
    currentlyResolving.length = 0;
    return new Error(stack ? `${ msg } (Resolving: ${ stack })` : msg);
  };

	// 2. 主要方法:
	// - get(): 获取命名服务实例
	// - invoke(): 调用函数并注入依赖
	// - instantiate(): 实例化类型并注入依赖
	// - createChild(): 创建子注入器

  /**
   * Return a named service.
   * 获取命名服务实例
   * 
   * @param {string} name - 服务名称
   * @param {boolean} [strict=true] if false, resolve missing services to null  - 严格模式,找不到服务时是否抛出异常
   *
   * @return {any} 服务实例
   */
  /**
   * 获取命名服务实例
   * 
   * @param {string} name - 服务名称
   * @param {boolean} [strict=true] - 严格模式，找不到服务时是否抛出异常
   * @return {any} 服务实例
   */
  function get(name, strict) {
    // 处理点表示法的属性访问（如 'service.property'）
    if (!providers[name] && name.includes('.')) {
      // 分割属性路径
      const parts = name.split('.');
      // 获取根服务
      let pivot = get(/** @type { string } */ (parts.shift()));

      // 逐层访问属性
      while (parts.length) {
        pivot = pivot[/** @type { string } */ (parts.shift())];
      }

      return pivot;
    }

    // 如果实例已存在，直接返回缓存的实例
    if (hasOwnProp(instances, name)) {
      return instances[name];
    }

    // 如果提供者存在，创建实例
    if (hasOwnProp(providers, name)) {
      // 检测循环依赖
      if (currentlyResolving.indexOf(name) !== -1) {
        currentlyResolving.push(name);
        throw error('Cannot resolve circular dependency!');
      }

      // 记录当前正在解析的服务
      currentlyResolving.push(name);
      // 调用提供者函数创建实例
      // providers[name][0] 是工厂函数，providers[name][1] 是依赖
      instances[name] = providers[name][0](providers[name][1]);
      // 解析完成，从解析栈中移除
      currentlyResolving.pop();

      return instances[name];
    }

    // 如果当前注入器没有找到，尝试从父注入器获取
    return parent.get(name, strict);
  }

  /**
   * 解析函数定义及其依赖
   * 该函数负责分析函数的依赖并准备注入所需的依赖项
   * 
   * @param {Function|Array} fn - 目标函数或带注解的数组
   * @param {Object} locals - 本地变量映射，用于覆盖从注入器获取的依赖
   * @return {Object} 包含原始函数和解析后依赖的对象
   */
  function fnDef(fn, locals) {
    // 确保locals是一个对象
    if (typeof locals === 'undefined') {
      locals = {};
    }

    // 处理不同类型的函数定义
    if (typeof fn !== 'function') {
      if (isArray(fn)) {
        // 处理数组形式的注解 ['dep1', 'dep2', function(dep1, dep2) {...}]
        fn = annotate(fn.slice());
      } else {
        // 既不是函数也不是数组，抛出错误
        throw error(`Cannot invoke "${ fn }". Expected a function!`);
      }
    }

    /**
     * 获取依赖注入列表
     * 优先使用显式声明的$inject属性，否则通过解析函数参数名获取
     * @type {string[]}
     */
    const inject = fn.$inject || parseAnnotations(fn);
    // 解析每个依赖，优先使用本地变量，否则从注入器获取
    const dependencies = inject.map(dep => {
      if (hasOwnProp(locals, dep)) {
        return locals[dep];
      } else {
        return get(dep);
      }
    });

    // 返回原始函数和解析后的依赖
    return {
      fn: fn,
      dependencies
    };
  }

  /**
   * 实例化给定类型，注入依赖
   * 该函数用于创建类的实例，并自动注入其构造函数所需的依赖
   *
   * @template T - 返回类型的泛型参数
   * @param {Function|Array} type - 要实例化的类型（可以是函数或带注解的数组）
   * @return {T} - 创建的实例
   */
  function instantiate(type) {
    // 解析类型定义及其依赖
    const {
      fn,
      dependencies
    } = fnDef(type);

    // 使用Function.prototype.bind创建一个预设参数的构造函数
    // 这样可以将依赖作为构造函数参数传入
    const Constructor = Function.prototype.bind.call(fn, null, ...dependencies);

    // 创建并返回新实例
    return new Constructor();
  }

  /**
   * 调用给定函数，注入依赖并返回结果
   * 该函数用于执行函数，自动注入其所需的依赖，并可指定执行上下文
   *
   * @template T - 返回值的泛型参数
   * @param {Function|Array} func - 要调用的函数（可以是函数或带注解的数组）
   * @param {Object} [context] - 函数执行的上下文（this值）
   * @param {Object} [locals] - 本地变量映射，用于覆盖从注入器获取的依赖
   * @return {T} - 函数调用的结果
   */
  function invoke(func, context, locals) {
    // 解析函数定义及其依赖
    const {
      fn,
      dependencies
    } = fnDef(func, locals);

    // 在指定上下文中调用函数，并传入依赖作为参数
    return fn.apply(context, dependencies);
  }

  /**
   * 创建私有注入器工厂函数
   * 该函数返回一个带注解的工厂函数，用于从子注入器获取服务
   *
   * @param {Injector} childInjector - 子注入器实例
   * @return {Function} - 带注解的工厂函数，用于从子注入器获取服务
   */
  function createPrivateInjectorFactory(childInjector) {
    // 返回一个带注解的函数，该函数将从子注入器获取服务
    // annotate函数会为返回的函数添加适当的依赖注入元数据
    return annotate(key => childInjector.get(key));
  }

  /**
   * 创建子注入器
   * 该方法用于创建一个新的注入器实例，继承父注入器的功能，同时可以强制某些服务使用新实例
   * 
   * @param {ModuleDefinition[]} modules - 要加载到子注入器的模块定义数组
   * @param {string[]} [forceNewInstances] - 需要强制创建新实例的服务名称数组
   *
   * @return {Injector} - 新创建的子注入器实例
   */
  function createChild(modules, forceNewInstances) {
    // 如果指定了需要强制创建新实例的服务
    if (forceNewInstances && forceNewInstances.length) {
      // 创建一个新的空对象，用于存储从父模块继承的服务提供者
      const fromParentModule = Object.create(null);
      // 创建一个新的空对象，用于跟踪已匹配的作用域
      const matchedScopes = Object.create(null);

      // 用于缓存私有注入器相关信息的数组
      const privateInjectorsCache = []; // 缓存私有注入器实例
      const privateChildInjectors = []; // 存储为强制新实例创建的子注入器
      const privateChildFactories = []; // 存储私有子注入器的工厂函数

      // 临时变量声明
      let provider;
      let cacheIdx;
      let privateChildInjector;
      let privateChildInjectorFactory;

      // 遍历当前注入器中的所有服务提供者
      for (let name in providers) {
        provider = providers[name];

        // 如果当前服务在强制新实例列表中
        if (forceNewInstances.indexOf(name) !== -1) {
          // 处理私有类型的提供者
          if (provider[2] === 'private') {
            // 检查是否已经为该私有注入器创建了子注入器
            cacheIdx = privateInjectorsCache.indexOf(provider[3]);
            if (cacheIdx === -1) {
              // 如果没有缓存，则创建新的私有子注入器
              privateChildInjector = provider[3].createChild([], forceNewInstances);
              privateChildInjectorFactory = createPrivateInjectorFactory(privateChildInjector);
              // 将新创建的注入器及其工厂函数添加到缓存中
              privateInjectorsCache.push(provider[3]);
              privateChildInjectors.push(privateChildInjector);
              privateChildFactories.push(privateChildInjectorFactory);
              // 设置从父模块继承的服务提供者
              fromParentModule[name] = [ privateChildInjectorFactory, name, 'private', privateChildInjector ];
            } else {
              // 如果已有缓存，则重用已创建的私有子注入器
              fromParentModule[name] = [ privateChildFactories[cacheIdx], name, 'private', privateChildInjectors[cacheIdx] ];
            }
          } else {
            // 对于非私有类型的提供者，直接复制类型和值
            fromParentModule[name] = [ provider[2], provider[1] ];
          }
          // 标记该作用域已匹配
          matchedScopes[name] = true;
        }

        // 处理带有$scope属性的工厂或类型提供者
        if ((provider[2] === 'factory' || provider[2] === 'type') && provider[1].$scope) {
          /* jshint -W083 */
          // 检查提供者的作用域是否包含在强制新实例列表中
          forceNewInstances.forEach(scope => {
            if (provider[1].$scope.indexOf(scope) !== -1) {
              // 如果作用域匹配，则将该提供者添加到fromParentModule中
              fromParentModule[name] = [ provider[2], provider[1] ];
              matchedScopes[scope] = true;
            }
          });
        }
      }

      // 验证所有强制新实例的作用域是否都已匹配
      forceNewInstances.forEach(scope => {
        if (!matchedScopes[scope]) {
          // 如果有未匹配的作用域，则抛出错误
          throw new Error('No provider for "' + scope + '". Cannot use provider from the parent!');
        }
      });

      // 将从父模块继承的服务提供者添加到模块列表的开头
      modules.unshift(fromParentModule);
    }

    // 创建并返回新的注入器实例，传入模块列表和当前注入器作为父级
    return new Injector(modules, self);
  }

	// 工厂类型
  const factoryMap = {
    factory: invoke,
    type: instantiate,
    value: function(value) {
      return value;
    }
  };

  /**
   * 创建模块初始化器
   * 该方法用于创建一个函数，该函数会执行模块定义中的所有初始化器
   * 
   * @param {ModuleDefinition} moduleDefinition - 模块定义对象，包含初始化器列表
   * @param {Injector} injector - 用于解析依赖的注入器实例
   * @return {Function} - 返回一个函数，调用该函数会执行所有初始化器
   */
  function createInitializer(moduleDefinition, injector) {
    // 获取模块定义中的初始化器列表，如果不存在则使用空数组
    const initializers = moduleDefinition.__init__ || [];

    // 返回一个函数，该函数会执行所有初始化器
    return function() {
      initializers.forEach(initializer => {
        // 立即解析组件（函数或字符串）
        if (typeof initializer === 'string') {
          // 如果初始化器是字符串，则通过注入器获取对应的服务
          injector.get(initializer);
        } else {
          // 如果初始化器是函数，则通过注入器调用该函数并注入依赖
          injector.invoke(initializer);
        }
      });
    };
  }

	// 3. 模块系统:
	// - loadModule(): 加载模块定义
	// - bootstrap(): 引导初始化模块
	// - resolveDependencies(): 解析模块间依赖

  /**
   * 加载模块定义
   * 该方法用于处理模块定义，设置模块导出，并处理私有模块的特殊逻辑
   * 
   * @param {ModuleDefinition} moduleDefinition - 要加载的模块定义对象
   */
  function loadModule(moduleDefinition) {
    // 获取模块定义中的导出项列表
    const moduleExports = moduleDefinition.__exports__;

    // 处理私有模块（有导出项的模块被视为私有模块）
    if (moduleExports) {
      // 获取嵌套模块列表
      const nestedModules = moduleDefinition.__modules__;

      // 克隆模块定义，但排除特殊属性
      const clonedModule = Object.keys(moduleDefinition).reduce((clonedModule, key) => {
        // 排除特殊属性：__exports__、__modules__、__init__、__depends__
        if (key !== '__exports__' && key !== '__modules__' && key !== '__init__' && key !== '__depends__') {
          clonedModule[key] = moduleDefinition[key];
        }

        return clonedModule;
      }, Object.create(null));

      // 合并嵌套模块和克隆的模块定义
      const childModules = (nestedModules || []).concat(clonedModule);

      // 为私有模块创建子注入器
      const privateInjector = createChild(childModules);
      // 创建一个函数，用于从私有注入器中获取服务
      const getFromPrivateInjector = annotate(function(key) {
        return privateInjector.get(key);
      });

      // 为每个导出项设置提供者，类型为'private'
      moduleExports.forEach(function(key) {
        providers[key] = [ getFromPrivateInjector, key, 'private', privateInjector ];
      });

      // 确保子注入器初始化
      // 复制模块定义中的初始化器列表
      const initializers = (moduleDefinition.__init__ || []).slice();

      // 在初始化器列表开头添加一个函数，用于初始化私有注入器
      initializers.unshift(function() {
        privateInjector.init();
      });

      // 更新模块定义，使用新的初始化器列表
      moduleDefinition = Object.assign({}, moduleDefinition, {
        __init__: initializers
      });

      // 为私有模块创建初始化器并返回
      return createInitializer(moduleDefinition, privateInjector);
    }

    // 处理普通模块（非私有模块）
    Object.keys(moduleDefinition).forEach(function(key) {
      // 跳过特殊属性：__init__和__depends__
      if (key === '__init__' || key === '__depends__') {
        return;
      }

      // 获取类型声明
      const typeDeclaration = /** @type { TypedDeclaration } */ (
        moduleDefinition[key]
      );

      // 如果是私有类型，直接设置提供者
      if (typeDeclaration[2] === 'private') {
        providers[key] = typeDeclaration;
        return;
      }

      // 获取类型和值
      const type = typeDeclaration[0];
      const value = typeDeclaration[1];

      // 设置提供者，使用对应的工厂函数处理值
      providers[key] = [ factoryMap[type], arrayUnwrap(type, value), type ];
    });

    // 为普通模块创建初始化器并返回
    return createInitializer(moduleDefinition, self);
  }

  /**
   * 解析模块依赖关系
   * 该方法用于处理模块之间的依赖关系，确保依赖模块在被依赖模块之前加载
   * 
   * @param {ModuleDefinition[]} moduleDefinitions - 已加载的模块定义数组
   * @param {ModuleDefinition} moduleDefinition - 当前处理的模块定义
   *
   * @return {ModuleDefinition[]} - 解析依赖后的模块定义数组
   */
  function resolveDependencies(moduleDefinitions, moduleDefinition) {
    // 如果模块已经在模块定义数组中，则直接返回，避免重复添加
    if (moduleDefinitions.indexOf(moduleDefinition) !== -1) {
      return moduleDefinitions;
    }

    // 递归处理当前模块的所有依赖模块
    // 确保所有依赖模块都被添加到模块定义数组中
    moduleDefinitions = (moduleDefinition.__depends__ || []).reduce(resolveDependencies, moduleDefinitions);

    // 再次检查当前模块是否已在模块定义数组中
    // 这是必要的，因为当前模块可能是其他模块的依赖，已经在递归过程中被添加
    if (moduleDefinitions.indexOf(moduleDefinition) !== -1) {
      return moduleDefinitions;
    }

    // 将当前模块添加到模块定义数组的末尾
    // 这确保了依赖模块总是在被依赖模块之前
    return moduleDefinitions.concat(moduleDefinition);
  }

  /**
   * 引导初始化模块
   * 该方法用于处理模块定义数组，解析依赖关系，加载模块，并返回一个初始化函数
   * 
   * @param {ModuleDefinition[]} moduleDefinitions - 要引导的模块定义数组
   *
   * @return { () => void } initializerFn - 返回一个初始化函数，调用该函数会执行所有模块的初始化器
   */
  function bootstrap(moduleDefinitions) {
    // 解析所有模块的依赖关系，并加载每个模块
    // 这确保了模块按照正确的依赖顺序加载
    const initializers = moduleDefinitions
      .reduce(resolveDependencies, [])
      .map(loadModule);

    // 标记是否已初始化
    let initialized = false;

    // 返回一个初始化函数
    return function() {
      // 防止重复初始化
      if (initialized) {
        return;
      }

      // 设置初始化标记
      initialized = true;

      // 执行所有模块的初始化器
      initializers.forEach(initializer => initializer());
    };
  }

  // 公共API - 暴露给外部使用的方法
  this.get = get;                // 获取命名服务实例
  this.invoke = invoke;          // 调用函数并注入依赖
  this.instantiate = instantiate; // 实例化类型并注入依赖
  this.createChild = createChild; // 创建子注入器

  // 设置初始化函数
  this.init = bootstrap(modules); // 返回一个函数，调用该函数会初始化所有模块
}


// 辅助函数 ///////////////

/**
 * 数组解包函数
 * 该函数用于处理依赖注入中的数组类型值，确保正确的注解处理
 * 
 * @param {string} type - 值的类型
 * @param {any} value - 要处理的值
 * @return {any} - 处理后的值
 */
function arrayUnwrap(type, value) {
  // 如果类型不是'value'且值是数组，则创建数组的副本并添加注解
  if (type !== 'value' && isArray(value)) {
    value = annotate(value.slice());
  }

  return value;
}