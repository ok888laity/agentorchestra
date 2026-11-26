import { For, Show, createSignal } from "solid-js";
import { Command, ComposerPill, MenuItem, Panel, Plugin } from "@opencode/plugin/gui";
import { Orchestra } from "./rpc.js";

const i18n = {
  en: {
    "pill.label": "AgentOrchestra",
    "pill.title": "Open the AgentOrchestra console inside this window",
    "pill.setup": "Boundaries",
    "pill.plan": "Submit",
    "pill.run": "Run",
    "pill.update": "Updates",
    "menu.open": "AgentOrchestra console",
    "command.open": "Open AgentOrchestra console",
    "panel.title": "AgentOrchestra"
  },
  zh: {
    "pill.label": "AgentOrchestra",
    "pill.title": "在软件内打开 AgentOrchestra 控制台",
    "pill.setup": "设边界",
    "pill.plan": "提交计划",
    "pill.run": "运行",
    "pill.update": "查更新",
    "menu.open": "AgentOrchestra 控制台",
    "command.open": "打开 AgentOrchestra 控制台",
    "panel.title": "AgentOrchestra"
  }
};

const ctl = {
  background: "var(--background, #161b22)",
  color: "var(--foreground, #e6edf3)",
  border: "1px solid var(--border, #30363d)",
  "border-radius": "6px",
  padding: "4px 8px",
  "color-scheme": "dark",
  cursor: "pointer"
};

const box = {
  border: "1px solid var(--border, #30363d)",
  "border-radius": "8px",
  padding: "8px",
  background: "var(--panel, transparent)"
};

const muted = { color: "var(--muted-foreground, #8b949e)", "font-size": "11px" };

function Console(props) {
  const [output, setOutput] = createSignal("点按钮开始");
  const [providers, setProviders] = createSignal([]);
  const [examples, setExamples] = createSignal([]);
  const [planName, setPlanName] = createSignal("");
  const [plan, setPlan] = createSignal("");
  const [tasks, setTasks] = createSignal([]);
  const [taskId, setTaskId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [selected, setSelected] = createSignal("");

  const call = async (name, input, after) => {
    setBusy(true);
    try {
      const result = await props.rpc()[name](input ?? {});
      setOutput(result.text);
      if (after) after(result.text);
    } catch (error) {
      setOutput("失败：" + String(error?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => {
    call("classify", {}, (text) => {
      try { setProviders(JSON.parse(text).groups ?? []); } catch { setProviders([]); }
    });
    call("examples", {}, (text) => {
      setExamples(text.split("\n---\n").filter(Boolean).map((block) => {
        const index = block.indexOf("\n");
        return { name: block.slice(0, index).replace(".json", ""), content: block.slice(index + 1) };
      }));
    });
    call("status", {}, (text) => {
      try { setTasks(Object.keys(JSON.parse(text).tasks ?? {})); } catch { setTasks([]); }
    });
  };

  const confirm = (group) => {
    call("confirmProvider", {
      provider: group.provider,
      billing: group.currentPolicy?.billing ?? group.billing.suggested,
      privacy: group.currentPolicy?.privacy ?? "unknown",
      enabled: group.currentPolicy?.enabled ?? !group.needsUserChoice
    }, refresh);
  };

  return (
    <div style={{ padding: "12px", "font-size": "13px", display: "flex", "flex-direction": "column", gap: "8px", "color-scheme": "dark", background: "var(--background, #0d1117)", color: "var(--foreground, #e6edf3)" }}>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button style={ctl} disabled={busy()} onClick={refresh}>检测</button>
        <button style={ctl} disabled={busy()} onClick={() => call("run", {})}>运行</button>
        <button style={ctl} disabled={busy()} onClick={() => call("checkUpdate", {})}>查更新</button>
        <button style={ctl} disabled={busy()} onClick={() => call("update", {})}>更新</button>
      </div>

      <div style={{ ...muted, "font-weight": "bold" }}>模型边界</div>
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <For each={providers()}>{(group) => (
          <div style={box}>
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
              <strong>{group.provider}</strong>
              <span style={muted}>{group.needsUserChoice ? "需确认" : "已确认"}</span>
            </div>
            <div style={muted}>{group.modelCount} 个 · {group.billing.suggested} / {group.privacy.suggested}</div>
            <Show when={selected() === group.provider}>
              <div style={{ display: "flex", gap: "6px", "margin-top": "6px", "flex-wrap": "wrap", "align-items": "center" }}>
                <select style={ctl} value={group.currentPolicy?.billing ?? group.billing.suggested} onChange={(e) => { group.currentPolicy.billing = e.currentTarget.value; setSelected(group.provider); }}>
                  <For each={["free", "local", "subscription", "api", "unknown"]}>{(v) => <option value={v}>{v}</option>}</For>
                </select>
                <select style={ctl} value={group.currentPolicy?.privacy ?? "unknown"} onChange={(e) => { group.currentPolicy.privacy = e.currentTarget.value; setSelected(group.provider); }}>
                  <For each={["local", "trusted", "public", "unknown"]}>{(v) => <option value={v}>{v}</option>}</For>
                </select>
                <label style={muted}><input type="checkbox" checked={group.currentPolicy?.enabled ?? false} onChange={(e) => { group.currentPolicy.enabled = e.currentTarget.checked; setSelected(group.provider); }} /> 启用</label>
                <button style={ctl} disabled={busy()} onClick={() => confirm(group)}>确认</button>
              </div>
            </Show>
            <button style={{ ...ctl, "margin-top": "6px", padding: "2px 6px" }} onClick={() => setSelected(selected() === group.provider ? "" : group.provider)}>
              {selected() === group.provider ? "收起" : "设置"}
            </button>
          </div>
        )}</For>
      </div>

      <div style={{ ...muted, "font-weight": "bold", "margin-top": "4px" }}>计划</div>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <For each={examples()}>{(example) => (
          <button style={ctl} onClick={() => { setPlan(example.content); setPlanName(example.name); }}>
            {example.name}{planName() === example.name ? " ✓" : ""}
          </button>
        )}</For>
      </div>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
        <button style={ctl} disabled={busy() || !plan()} onClick={() => call("submitPlan", { plan: plan() }, refresh)}>提交</button>
        <button style={ctl} disabled={busy()} onClick={() => call("pool", {})}>规划</button>
        <select style={ctl} value={taskId()} onChange={(e) => setTaskId(e.currentTarget.value)}>
          <option value="">选任务</option>
          <For each={tasks()}>{(id) => <option value={id}>{id}</option>}</For>
        </select>
        <button style={ctl} disabled={busy() || !taskId()} onClick={() => call("routePreview", { taskId: taskId() })}>预览</button>
      </div>

      <pre style={{ ...box, "white-space": "pre-wrap", "max-height": "120px", overflow: "auto", margin: 0, "font-size": "11px" }}>{output()}</pre>
    </div>
  );
}

export default Plugin.define({
  i18n,
  setup(ctx) {
    const rpc = () => ctx.client.rpc(Orchestra);
    const open = () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:main`, session);
      else ctx.commands.run(`${ctx.id}.open`);
    };

    ctx.add(ComposerPill, {
      id: "orchestra",
      show: () => ({
        label: ctx.t("pill.label"),
        title: ctx.t("pill.title"),
        icon: "sparkles",
        rows: [
          { id: "setup", label: ctx.t("pill.setup"), run: open },
          { id: "plan", label: ctx.t("pill.plan"), run: open },
          { id: "run", label: ctx.t("pill.run"), run: () => void rpc().run({}) },
          { id: "update", label: ctx.t("pill.update"), run: () => void rpc().checkUpdate({}) }
        ]
      })
    });

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "open",
      title: ctx.t("menu.open"),
      icon: "sparkles",
      run: open
    });

    ctx.add(Command, {
      id: "open",
      title: ctx.t("command.open"),
      section: "model",
      slash: { name: "orchestra" },
      featured: true,
      run: open
    });

    ctx.add(Panel, {
      id: "main",
      region: "side",
      width: 420,
      list: (input) => (input.open.includes("main") ? [{
        id: "main",
        get title() { return ctx.t("panel.title"); },
        closable: "compact",
        fallback: true
      }] : []),
      render: () => <Console rpc={rpc} />
    });
  }
});
