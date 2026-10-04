// Tiny i18n layer: one flat string table per language + a `t()` lookup.
//
// Deliberately dependency-free (no i18n library) - the dashboard has a few
// dozen strings and two languages, so a table plus a context is the whole
// mechanism. Components read the active language from LangContext and translate
// with the `useT()` hook; code outside React (chartOption.js, which builds
// ECharts options) calls the plain `translate(lang, key, params)` instead.
//
// `{name}` placeholders in a string are filled from the `params` object.
import { createContext, useCallback, useContext } from "react";

export const LANGS = [
  { id: "zh", label: "中文", htmlLang: "zh-CN" },
  { id: "en", label: "EN", htmlLang: "en" },
];

export const DEFAULT_LANG = "en";

/**
 * The language to start in: a previously stored choice wins, otherwise the
 * browser's own preference - Chinese browsers get 中文, everyone else English.
 */
export function detectLang(stored) {
  if (LANGS.some((l) => l.id === stored)) return stored;
  const nav = (navigator.language || navigator.languages?.[0] || "").toLowerCase();
  return nav.startsWith("zh") ? "zh" : DEFAULT_LANG;
}

const STRINGS = {
  zh: {
    "app.title": "12V 供电监控面板",
    "app.deviceStatus": "设备{status}",
    "app.langAria": "语言",

    "tab.live": "实时监控",
    "tab.history": "历史查询",
    "tab.alerts": "异常日志",
    "tab.ota": "固件更新",

    "unit.aria": "电流与功率单位",

    "metric.voltage": "电压",
    "metric.current": "电流",
    "metric.power": "功率",
    "metric.temperature": "温度",
    "metric.device": "设备",
    "metric.link": "链路",

    "status.online": "在线",
    "status.offline": "离线",
    "status.unknown": "未知",

    "link.connecting": "连接中",
    "link.connected": "已连接",
    "link.reconnecting": "重连中",

    "live.badge": "实时",
    "live.window": "显示窗口",
    "live.window.30s": "30 秒",
    "live.window.1m": "1 分钟",
    "live.window.2m": "2 分钟",
    "live.window.5m": "5 分钟",
    "live.viewers": "查看人数 {n}",

    "history.start": "起始时间",
    "history.end": "结束时间",
    "history.limit": "条数上限",
    "history.query": "查询",
    "history.querying": "查询中…",
    "history.count": "记录数",
    "history.avgVoltage": "电压均值",
    "history.avgCurrent": "电流均值",
    "history.avgPower": "功率均值",
    "history.avgTemperature": "温度均值",
    "history.empty": "尚无查询结果 — 设置时间范围（留空表示不限）后点击“查询”。",

    "col.time": "时间",
    "col.withUnit": "{metric} ({unit})",
    "col.source": "来源",
    "col.type": "类型",

    "alerts.total": "事件总数",
    "alerts.device": "设备告警",
    "alerts.host": "后端阈值",
    "alerts.deviceSub": "INA226 ALERT 引脚",
    "alerts.hostSub": "后端电流判定",
    "alerts.source.device": "设备告警",
    "alerts.source.host": "后端阈值",
    "alerts.type.ocp": "过流",
    "alerts.loading": "加载中…",
    "alerts.loadError": "加载失败：{err}",
    "alerts.empty":
      "尚无过流事件 — 电流超过阈值时，两条检测路径（设备 ALERT 引脚 + 后端阈值）会各自记录一条。",

    "ota.currentFirmware": "当前固件",
    "ota.currentSlot": "当前 OTA 槽位",
    "ota.runningVersion": "设备运行版本",
    "ota.notReportedOld": "设备未上报（未连接或旧固件）",
    "ota.runningPartition": "运行分区",
    "ota.notReported": "设备未上报",
    "ota.title": "固件更新（OTA）",
    "ota.stored": "已保存固件 · {size}",
    "ota.none": "未上传固件",
    "ota.uploadedAt": "上传于 {time}",
    "ota.choose": "选择 .bin 固件",
    "ota.push": "推送到设备",
    "ota.pushing": "发送中…",
    "ota.saved": "已保存固件 {name}（{size}）。",
    "ota.uploadFailed": "上传失败：{err}",
    "ota.confirm": "即将向设备发送 OTA 命令，设备将重启进入新固件。确认继续？",
    "ota.sent": "命令已发送，设备即将重启。",
    "ota.updateFailed": "更新失败：{err}",
    "ota.hint":
      "流程：选择固件 .bin → “推送到设备”。设备会拉取并重启；设备{status}。若新固件无法启动，设备将自动回滚到上一版本。",
  },

  en: {
    "app.title": "12V Power Monitor",
    "app.deviceStatus": "Device {status}",
    "app.langAria": "Language",

    "tab.live": "Live",
    "tab.history": "History",
    "tab.alerts": "Alerts",
    "tab.ota": "Firmware",

    "unit.aria": "Current and power units",

    "metric.voltage": "Voltage",
    "metric.current": "Current",
    "metric.power": "Power",
    "metric.temperature": "Temperature",
    "metric.device": "Device",
    "metric.link": "Link",

    "status.online": "online",
    "status.offline": "offline",
    "status.unknown": "unknown",

    "link.connecting": "connecting",
    "link.connected": "connected",
    "link.reconnecting": "reconnecting",

    "live.badge": "LIVE",
    "live.window": "Window",
    "live.window.30s": "30 s",
    "live.window.1m": "1 min",
    "live.window.2m": "2 min",
    "live.window.5m": "5 min",
    "live.viewers": "Viewers {n}",

    "history.start": "Start time",
    "history.end": "End time",
    "history.limit": "Limit",
    "history.query": "Query",
    "history.querying": "Querying…",
    "history.count": "Records",
    "history.avgVoltage": "Avg voltage",
    "history.avgCurrent": "Avg current",
    "history.avgPower": "Avg power",
    "history.avgTemperature": "Avg temperature",
    "history.empty": "No results yet — set a time range (leave blank for unlimited) and click “Query”.",

    "col.time": "Time",
    "col.withUnit": "{metric} ({unit})",
    "col.source": "Source",
    "col.type": "Type",

    "alerts.total": "Total events",
    "alerts.device": "Device alerts",
    "alerts.host": "Backend threshold",
    "alerts.deviceSub": "INA226 ALERT pin",
    "alerts.hostSub": "Backend current check",
    "alerts.source.device": "Device",
    "alerts.source.host": "Backend",
    "alerts.type.ocp": "Overcurrent",
    "alerts.loading": "Loading…",
    "alerts.loadError": "Load failed: {err}",
    "alerts.empty":
      "No overcurrent events yet — when current exceeds the threshold, both detectors (device ALERT pin + backend threshold) record one each.",

    "ota.currentFirmware": "Current firmware",
    "ota.currentSlot": "Current OTA slot",
    "ota.runningVersion": "Version running on the device",
    "ota.notReportedOld": "Not reported (offline, or old firmware)",
    "ota.runningPartition": "Running partition",
    "ota.notReported": "Not reported",
    "ota.title": "Firmware update (OTA)",
    "ota.stored": "Firmware stored · {size}",
    "ota.none": "No firmware uploaded",
    "ota.uploadedAt": "Uploaded {time}",
    "ota.choose": "Choose .bin firmware",
    "ota.push": "Push to device",
    "ota.pushing": "Sending…",
    "ota.saved": "Saved firmware {name} ({size}).",
    "ota.uploadFailed": "Upload failed: {err}",
    "ota.confirm": "Send the OTA command to the device? It will reboot into the new firmware.",
    "ota.sent": "Command sent; the device will reboot shortly.",
    "ota.updateFailed": "Update failed: {err}",
    "ota.hint":
      "Flow: choose a .bin → “Push to device”. The device pulls it and reboots; device is {status}. If the new firmware fails to boot, the device rolls back automatically.",
  },
};

export const LangContext = createContext(DEFAULT_LANG);

/** Translate `key` into `lang`, filling `{name}` placeholders from `params`. */
export function translate(lang, key, params) {
  const table = STRINGS[lang] ?? STRINGS[DEFAULT_LANG];
  let s = table[key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ""));
  }
  return s;
}

/** The active language id. */
export function useLang() {
  return useContext(LangContext);
}

/** The translator for the active language: `const t = useT(); t("tab.live")`. */
export function useT() {
  const lang = useLang();
  return useCallback((key, params) => translate(lang, key, params), [lang]);
}
