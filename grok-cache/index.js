const LRU = require('lru-cache');
const crypto = require('crypto');
const Redis = require('ioredis');

// 插件标准导出结构，项目插件加载器识别该格式
module.exports = {
  name: "grok-cache-adapter",
  version: "1.0.0",
  author: "custom-dev",
  description: "Grok API 请求缓存适配插件，复用重复对话响应，节省Token与速率限额",

  // 插件注册钩子，框架自动传入 app、全局配置、插件自身上下文
  register: async function (app, globalConfig, pluginCtx) {
    const cfg = pluginCtx.config;
    let cacheInstance = null;

    // 初始化缓存实例（内存 / Redis 双模式）
    if (cfg.cacheMode === "redis") {
      const redisClient = new Redis(cfg.redisUrl);
      cacheInstance = {
        get: async (key) => {
          const raw = await redisClient.get(key);
          return raw ? JSON.parse(raw) : null;
        },
        set: async (key, val) => {
          const ttlSec = Math.floor(cfg.cacheTTL / 1000);
          await redisClient.set(key, JSON.stringify(val), "EX", ttlSec);
        },
        clearAll: async () => {
          const keys = await redisClient.keys(`${cfg.cacheKeyPrefix}*`);
          if (keys.length) await redisClient.del(keys);
        }
      };
      pluginCtx.redis = redisClient;
    } else {
      const lruStore = new LRU({
        max: cfg.memoryMaxSize,
        ttl: cfg.cacheTTL
      });
      cacheInstance = {
        get: async (key) => lruStore.get(key),
        set: async (key, val) => lruStore.set(key, val),
        clearAll: async () => lruStore.clear()
      };
    }

    // 生成Grok专属缓存唯一key
    const buildCacheKey = (body) => {
      const { model, messages, temperature = 0.7, top_p = 1, max_tokens = 1024, stream } = body;
      // 流式、黑名单模型直接跳过缓存
      if (cfg.skipStream && stream) return null;
      if (cfg.skipModelList.includes(model)) return null;
      if (!model || !model.startsWith("grok-")) return null;

      const hashSource = JSON.stringify({
        model, messages, temperature, top_p, max_tokens
      });
      const md5 = crypto.createHash("md5").update(hashSource).digest("hex");
      return `${cfg.cacheKeyPrefix}${md5}`;
    };

    // 挂载前置拦截中间件
    app.use(async (req, res, next) => {
      // 仅拦截标准chat completions接口
      if (!req.path.includes("/v1/chat/completions")) return next();
      const reqBody = req.body || {};
      const cacheKey = buildCacheKey(reqBody);
      if (!cacheKey) return next();

      // 命中缓存直接返回，跳过上游转发逻辑
      const cachedData = await cacheInstance.get(cacheKey);
      if (cachedData) {
        return res.json(cachedData);
      }

      // 劫持原生json返回方法，响应落地后写入缓存
      const originJsonFunc = res.json;
      res.json = async function (respData) {
        await cacheInstance.set(cacheKey, respData);
        return originJsonFunc.call(res, respData);
      };
      next();
    });

    // 挂载插件专属管理接口（面板可调用清理缓存）
    app.get("/plugin/grok-cache/clear", async (req, res) => {
      await cacheInstance.clearAll();
      res.json({ code: 0, msg: "Grok缓存全部清空成功" });
    });

    pluginCtx.cache = cacheInstance;
    console.log("[Plugin] grok-cache-adapter 注册完成");
  },

  // 插件卸载钩子，关闭redis连接、释放资源
  unregister: async function (app, globalConfig, pluginCtx) {
    if (pluginCtx.redis) {
      await pluginCtx.redis.quit();
    }
    console.log("[Plugin] grok-cache-adapter 已卸载");
  }
};
