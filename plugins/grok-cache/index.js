const LRU = require('lru-cache');
const crypto = require('crypto');
const Redis = require('ioredis');

// 缓存实例全局变量
let cacheStore = null;
let redisClient = null;

module.exports = {
  name: "grok-cache",
  version: "1.0.0",
  author: "custom",
  description: "Grok 请求缓存插件，复用相同参数对话，节省 Token 与调用限额",

  register: async (app, config, ctx) => {
    // 跳过插件关闭状态
    if (!config.enable) {
      console.log("[grok-cache] 插件已关闭，跳过注册");
      return;
    }

    // 初始化缓存
    if (config.cache_mode === "redis") {
      redisClient = new Redis(config.redis_url);
      cacheStore = {
        get: async (key) => {
          const raw = await redisClient.get(key);
          return raw ? JSON.parse(raw) : null;
        },
        set: async (key, val) => {
          const sec = Math.floor(config.cache_ttl_ms / 1000);
          await redisClient.set(key, JSON.stringify(val), "EX", sec);
        },
        clear: async () => {
          const keys = await redisClient.keys(`${config.cache_prefix}*`);
          if (keys.length) await redisClient.del(keys);
        }
      };
    } else {
      const lru = new LRU({
        max: config.memory_max,
        ttl: config.cache_ttl_ms
      });
      cacheStore = {
        get: async (k) => lru.get(k),
        set: async (k, v) => lru.set(k, v),
        clear: async () => lru.clear()
      };
    }

    // 生成缓存 Key
    const makeCacheKey = (body) => {
      const { model, messages, temperature = 0.7, top_p = 1, max_tokens = 1024, stream } = body;
      // 流式、黑名单、非grok模型直接不缓存
      if (config.skip_stream && stream) return null;
      if (!model || !model.startsWith("grok-")) return null;
      if (config.skip_models.includes(model)) return null;

      const sign = JSON.stringify({ model, messages, temperature, top_p, max_tokens });
      const md5 = crypto.createHash("md5").update(sign).digest("hex");
      return config.cache_prefix + md5;
    };

    // 全局前置中间件拦截 /v1/chat/completions
    app.use((req, res, next) => {
      if (!req.path.endsWith("/v1/chat/completions")) return next();
      const body = req.body || {};
      const key = makeCacheKey(body);
      if (!key) return next();

      // 命中缓存直接返回
      cacheStore.get(key).then(cacheData => {
        if (cacheData) {
          return res.json(cacheData);
        }
        // 劫持 res.json 写入缓存
        const oldJson = res.json;
        res.json = function (data) {
          cacheStore.set(key, data).catch(console.error);
          return oldJson.call(this, data);
        };
        next();
      }).catch(err => next());
    });

    // 缓存清理管理接口 /plugin/grok-cache/clear
    app.get("/plugin/grok-cache/clear", async (req, res) => {
      try {
        await cacheStore.clear();
        res.json({ code: 0, msg: "Grok 缓存清空成功" });
      } catch (e) {
        res.json({ code: -1, msg: "清空失败", err: e.message });
      }
    });

    console.log("[grok-cache] 插件注册完成");
  },

  unregister: async () => {
    // 释放 Redis 连接
    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
    }
    cacheStore = null;
    console.log("[grok-cache] 插件已卸载，资源释放完毕");
  }
};
