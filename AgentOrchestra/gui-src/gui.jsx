import { For, Show, createSignal } from "solid-js";
import { Command, ComposerPill, MenuItem, Panel, Plugin } from "@opencode/plugin/gui";
import { Orchestra } from "./rpc.js";

const i18n = {
  en: {
    "pill.label": "AgentOrchestra",
    "pill.title": "Open the AgentOrchestra console inside this window",
    "pill.setup": "Confirm model boundaries",
    "pill.plan": "Submit a DAG plan",
    "pill.run": "Run ready tasks",
    "pill.update": "Check for updates",
    "menu.open": "AgentOrchestra console",
    "command.open": "Open AgentOrchestra console",
    "panel.title": "AgentOrchestra"
  },
  zh: {
    "pill.label": "AgentOrchestra",
    "pill.title": "在软件内打开 AgentOrchestra 控制台",
    "pill.setup": "确认模型边界",
    "pill.plan": "提交 DAG 计划",
    "pill.run": "运行待办任务",
    "pill.update": "检查更新",
    "menu.open": "AgentOrchestra 控制台",
    "command.open": "打开 AgentOrchestra 控制台",
    "panel.title": "AgentOrchestra"
  }
};

function Console(props) {
  const [output, setOutput] = createSignal("点击按钮开始。所有操作都在这个面板里完成，不会在对话里提问。");
  const [providers, setProviders] = createSignal([]);
  const [examples, setExamples] = createSignal([]);
  const [plan, setPlan] = createSignal("");
  const [tasks, setTasks] = createSignal([]);
  const [taskId, setTaskId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [provider, setProvider] = createSignal("");
  const [billing, setBilling] = createSignal("unknown");
  const [privacy, setPrivacy] = createSignal("unknown");
  const [enabled, setEnabled] = createSignal(false);

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
      try {
        const report = JSON.parse(text);
        setProviders(report.groups ?? []);
      } catch {
        setProviders([]);
      }
    });
    call("examples", {}, (text) => {
      setExamples(text.split("\n---\n").filter(Boolean).map((block) => {
        const index = block.indexOf("\n");
        return { name: block.slice(0, index), content: block.slice(index + 1) };
      }));
    });
    call("status", {}, (text) => {
      try {
        const snapshot = JSON.parse(text);
        setTasks(Object.keys(snapshot.tasks ?? {}));
      } catch {
        setTasks([]);
      }
    });
  };

  return (
    <div style={{ padding: "12px", "font-size": "13px", display: "flex", "flex-direction": "column", gap: "10px", height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button disabled={busy()} onClick={refresh}>重新检测</button>
        <button disabled={busy()} onClick={() => call("run", {})}>运行待办</button>
        <button disabled={busy()} onClick={() => call("checkUpdate", {})}>检查更新</button>
        <button disabled={busy()} onClick={() => call("update", {})}>立即更新</button>
      </div>

      <h3 style={{ margin: "4px 0" }}>首次设置 · Provider 计费 / 隐私</h3>
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <For each={providers()}>{(group) => (
          <div style={{ border: "1px solid var(--border, #333)", "border-radius": "8px", padding: "8px" }}>
            <strong>{group.provider}</strong> · {group.modelCount} 模型 ·
            建议 {group.billing.suggested} / {group.privacy.suggested} · {group.needsUserChoice ? "需确认" : "已确认"}
            <div style={{ color: "var(--muted-foreground, #888)", "font-size": "11px" }}>
              {[...(group.billing.evidence ?? []), ...(group.privacy.evidence ?? [])].join(" · ")}
            </div>
            <button onClick={() => {
              setProvider(group.provider);
              setBilling(group.currentPolicy?.billing ?? group.billing.suggested);
              setPrivacy(group.currentPolicy?.privacy ?? "unknown");
              setEnabled(Boolean(group.currentPolicy?.enabled));
            }}>选择</button>
          </div>
        )}</For>
      </div>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
        <select value={provider()} onChange={(event) => setProvider(event.currentTarget.value)}>
          <option value="">选择 provider</option>
          <For each={providers()}>{(group) => <option value={group.provider}>{group.provider}</option>}</For>
        </select>
        <select value={billing()} onChange={(event) => setBilling(event.currentTarget.value)}>
          <For each={["free", "local", "subscription", "api", "unknown"]}>{(value) => <option value={value}>{value}</option>}</For>
        </select>
        <select value={privacy()} onChange={(event) => setPrivacy(event.currentTarget.value)}>
          <For each={["local", "trusted", "public", "unknown"]}>{(value) => <option value={value}>{value}</option>}</For>
        </select>
        <label><input type="checkbox" checked={enabled()} onChange={(event) => setEnabled(event.currentTarget.checked)} /> 启用</label>
        <button disabled={busy() || !provider()} onClick={() => call("confirmProvider", {
          provider: provider(), billing: billing(), privacy: privacy(), enabled: enabled()
        }, refresh)}>确认此 provider</button>
      </div>

      <h3 style={{ margin: "4px 0" }}>计划工作台</h3>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <For each={examples()}>{(example) => <button onClick={() => setPlan(example.content)}>载入 {example.name}</button>}</For>
      </div>
      <textarea value={plan()} onInput={(event) => setPlan(event.currentTarget.value)} rows="6" placeholder="粘贴 DAG 计划 JSON" />
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button disabled={busy() || !plan()} onClick={() => call("submitPlan", { plan: plan() }, refresh)}>提交 DAG 计划</button>
        <button disabled={busy()} onClick={() => call("pool", {})}>规划模型池</button>
      </div>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
        <select value={taskId()} onChange={(event) => setTaskId(event.currentTarget.value)}>
          <option value="">选择任务</option>
          <For each={tasks()}>{(id) => <option value={id}>{id}</option>}</For>
        </select>
        <button disabled={busy() || !taskId()} onClick={() => call("routePreview", { taskId: taskId() })}>预览路由</button>
      </div>
      <pre style={{ "white-space": "pre-wrap", background: "var(--muted, #111)", padding: "8px", "border-radius": "8px", margin: 0 }}>{output()}</pre>
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
      width: 520,
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
