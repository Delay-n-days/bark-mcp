/**
 * 场景库：Web UI 与 MCP 共用同一份数据。
 *
 * 每个场景就是一份可以直接发送的 Bark payload；`encrypt: true` 的场景
 * 默认走加密链路。
 */
import type { PushOptions } from "./bark.ts";

export interface Scenario {
  key: string;
  icon: string;
  label: string;
  desc: string;
  payload: PushOptions;
  encrypt?: boolean;
}

export interface ScenarioGroup {
  name: string;
  items: Scenario[];
}

export const SCENARIO_GROUPS: ScenarioGroup[] = [
  {
    name: "内容",
    items: [
      {
        key: "basic",
        icon: "📨",
        label: "基础推送",
        desc: "标题 + 副标题 + 正文",
        payload: { title: "测试标题", subtitle: "来自 Bark 游乐场", body: "这是一条基础推送 ✅" },
      },
      {
        key: "bodyonly",
        icon: "💬",
        label: "仅正文",
        desc: "不显示标题行",
        payload: { body: "只有正文的通知，没有标题和副标题" },
      },
      {
        key: "markdown",
        icon: "📝",
        label: "Markdown",
        desc: "会忽略 body",
        payload: {
          title: "Markdown 推送",
          markdown:
            "# 一级标题\n\n**加粗**、*斜体*、~~删除线~~、[链接](https://bark.day.app)\n\n- 列表一\n- 列表二\n\n> 引用块\n\n```js\nconsole.log(\"code\")\n```",
        },
      },
    ],
  },
  {
    name: "展示与分组",
    items: [
      {
        key: "group",
        icon: "🗂️",
        label: "消息分组",
        desc: "group=demo-group",
        payload: { title: "分组消息", body: "同一个 group 会归到一组", group: "demo-group" },
      },
      {
        key: "icon",
        icon: "🎨",
        label: "自定义图标",
        desc: "icon，iOS 15+",
        payload: {
          title: "自定义图标",
          body: "通知左侧换成 Bark 头像",
          icon: "https://day.app/assets/images/avatar.jpg",
        },
      },
      {
        key: "image",
        icon: "🖼️",
        label: "推送大图",
        desc: "image，展开可见",
        payload: {
          title: "推送大图",
          body: "展开通知查看大图",
          image: "https://day.app/assets/images/avatar.jpg",
        },
      },
      { key: "badge", icon: "🔢", label: "角标 +3", desc: "badge=3", payload: { title: "角标 +3", body: "看看 App 图标角标", badge: 3 } },
      {
        key: "badgeclear",
        icon: "🧹",
        label: "清除角标",
        desc: "badge=0",
        payload: { title: "清除角标", body: "角标和通知中心都会被清除", badge: 0 },
      },
    ],
  },
  {
    name: "提醒与铃声",
    items: [
      {
        key: "timesensitive",
        icon: "⏱️",
        label: "时效性",
        desc: "timeSensitive",
        payload: { title: "时效性通知", body: "专注模式下也能显示", level: "timeSensitive" },
      },
      {
        key: "passive",
        icon: "🤫",
        label: "静默通知",
        desc: "passive，不亮屏",
        payload: { title: "静默通知", body: "只进通知列表，不亮屏", level: "passive" },
      },
      {
        key: "critical",
        icon: "🚨",
        label: "重要警告",
        desc: "critical + 音量 8",
        payload: { title: "重要警告", body: "静音模式下也会响铃 🔔", level: "critical", volume: 8, sound: "alarm" },
      },
      {
        key: "call",
        icon: "📞",
        label: "循环响铃",
        desc: "call=1，30 秒",
        payload: { title: "循环响铃", body: "铃声会循环 30 秒", call: "1", sound: "minuet" },
      },
      {
        key: "sound",
        icon: "🎵",
        label: "自定义铃声",
        desc: "sound=birdsong",
        payload: { title: "自定义铃声", body: "播放 birdsong", sound: "birdsong" },
      },
    ],
  },
  {
    name: "复制与跳转",
    items: [
      {
        key: "copy",
        icon: "📋",
        label: "自动复制验证码",
        desc: "copy + automaticallycopy",
        payload: { title: "验证码", body: "你的验证码是 123456", copy: "123456", automaticallycopy: "1" },
      },
      {
        key: "url",
        icon: "🔗",
        label: "点击跳转",
        desc: "url",
        payload: { title: "点击跳转", body: "点击通知打开 Bark 官网", url: "https://bark.day.app" },
      },
      {
        key: "alert",
        icon: "💡",
        label: "操作弹窗",
        desc: "action=alert",
        payload: { title: "操作弹窗", body: "点击后弹出复制/分享", action: "alert" },
      },
      {
        key: "none",
        icon: "📱",
        label: "仅打开 App",
        desc: "action=none",
        payload: { title: "只打开 App", body: "不跳转到具体页面", action: "none" },
      },
    ],
  },
  {
    name: "保存与管理",
    items: [
      {
        key: "noarchive",
        icon: "🚫",
        label: "不保存",
        desc: "isArchive=0",
        payload: { title: "不保存", body: "这条不会进入历史记录", isArchive: "0" },
      },
      {
        key: "ttl",
        icon: "⏳",
        label: "60 秒过期",
        desc: "ttl=60 + 保存",
        payload: { title: "临时消息", body: "60 秒后从历史和通知中心删除", ttl: 60, isArchive: "1" },
      },
      {
        key: "progress",
        icon: "📊",
        label: "进度更新",
        desc: "同 id 更新同一条",
        payload: { title: "下载进度", body: "已完成 40%", id: "demo-progress", isArchive: "1" },
      },
      {
        key: "delete",
        icon: "🗑️",
        label: "删除通知",
        desc: "先发进度，再发这个",
        payload: { id: "demo-progress", delete: "1" },
      },
    ],
  },
  {
    name: "加密",
    items: [
      {
        key: "encrypted",
        icon: "🔒",
        label: "加密基础推送",
        desc: "开启加密后发送",
        encrypt: true,
        payload: { title: "加密推送", subtitle: "本地加密", body: "服务器和 APNs 都看不到这条明文" },
      },
    ],
  },
];

export const SCENARIOS: Scenario[] = SCENARIO_GROUPS.flatMap((group) => group.items);

export function findScenario(key: string): Scenario | undefined {
  const needle = key.trim().toLowerCase();
  return SCENARIOS.find((scenario) => scenario.key.toLowerCase() === needle);
}
