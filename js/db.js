// 本地优先数据层：所有数据存 IndexedDB，不上传任何服务器。
import { uid } from "./util.js";

const DB_NAME = "personal-workbench";
const DB_VERSION = 3;

// categories.kind: "task" | "diary" | "book"
// workouts: 健身训练计划与动作；books: 本地图书；readingLog: 阅读时长记录
export const STORES = ["tasks", "captures", "notes", "pomodoro", "diary", "categories", "settings", "workouts", "books", "readingLog"];

let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          if (s === "settings") db.createObjectStore(s, { keyPath: "k" });
          else db.createObjectStore(s, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

export const db = {
  async getAll(store) {
    const os = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = os.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async get(store, id) {
    const os = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = os.get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async put(store, item) {
    const os = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = os.put(item);
      r.onsuccess = () => res(item);
      r.onerror = () => rej(r.error);
    });
  },
  async del(store, id) {
    const os = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = os.delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
  async clearStore(store) {
    const os = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = os.clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },

  // ---- settings (key-value) ----
  async getSetting(k, def = null) {
    const row = await this.get("settings", k);
    return row ? row.v : def;
  },
  async setSetting(k, v) {
    return this.put("settings", { k, v });
  },

  // ---- 导出 / 导入 ----
  async exportAll() {
    const data = {};
    for (const s of STORES) {
      if (s === "settings") continue;
      data[s] = await this.getAll(s);
    }
    return { app: "personal-workbench", version: 1, exportedAt: Date.now(), data };
  },
  async importAll(obj, { mode = "replace" } = {}) {
    if (!obj || !obj.data) throw new Error("文件格式不正确");
    for (const s of STORES) {
      if (s === "settings" || !obj.data[s]) continue;
      if (mode === "replace") await this.clearStore(s);
      for (const item of obj.data[s]) {
        if (mode === "merge" && (await this.get(s, item.id))) continue;
        await this.put(s, item);
      }
    }
  },
};

export { uid };
