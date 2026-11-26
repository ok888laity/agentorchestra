import { For, Show, createSignal } from "solid-js";
import { Command, ComposerPill, MenuItem, Panel, Plugin, SettingsPage } from "@opencode/plugin/gui";
import { Orchestra } from "./rpc.js";

const i18n = {
  en: {
    "pill.label": "AgentOrchestra",
    "pill.title": "Open AgentOrchestra settings",
    "pill.setup": "Model boundaries",
    "pill.plan": "Submit plan",
    "pill.run": "Run",
    "pill.update": "Updates",
    "menu.open": "AgentOrchestra settings",
    "command.open": "Open AgentOrchestra settings",
    "panel.title": "AgentOrchestra",
    "page.title": "AgentOrchestra",
    "page.description": "Cost-aware model routing with provider boundaries, planning and review.",
    "sec.providers": "Provider boundaries",
    "sec.providers.desc": "Confirm billing and privacy before any model is used.",
    "sec.plan": "Plan",
    "sec.plan.desc": "Load an example, submit a DAG and plan worker slots.",
    "sec.actions": "Actions",
    "sec.actions.desc": "Run tasks and keep the plugin up to date.",
    "field.provider": "Provider",
    "field.billing": "Billing",
    "field.privacy": "Privacy",
    "field.enabled": "Enabled",
    "field.task": "Task",
    "btn.confirm": "Confirm",
    "btn.submit": "Submit",
    "btn.pool": "Plan pool",
    "btn.preview": "Preview route",
    "btn.run": "Run",
    "btn.check": "Check updates",
    "btn.update": "Update now",
    "result": "Result",
    "empty": "No result yet."
  },
  zh: {
    "pill.label": "AgentOrchestra",
    "pill.title": "打开 AgentOrchestra 设置",
    "pill.setup": "设边界",
    "pill.plan": "提交计划",
    "pill.run": "运行",
    "pill.update": "查更新",
    "menu.open": "AgentOrchestra 设置",
    "command.open": "打开 AgentOrchestra 设置",
    "panel.title": "AgentOrchestra",
    "page.title": "AgentOrchestra",
    "page.description": "成本感知的模型路由：先确认 provider 边界，再规划和审查。",
    "sec.providers": "模型边界",
    "sec.providers.desc": "使用任何模型前，先确认其计费与隐私边界。",
    "sec.plan": "计划",
    "sec.plan.desc": "载入示例、提交 DAG、规划工作槽位。",
    "sec.actions": "操作",
    "sec.actions.desc": "运行任务并检查插件更新。",
    "field.provider": "Provider",
    "field.billing": "计费",
    "field.privacy": "隐私",
    "field.enabled": "启用",
    "field.task": "任务",
    "btn.confirm": "确认",
    "btn.submit": "提交",
    "btn.pool": "规划",
    "btn.preview": "预览",
    "btn.run": "运行",
    "btn.check": "查更新",
    "btn.update": "更新",
    "result": "结果",
    "empty": "暂无结果"
  }
};

const BILLING = ["free", "local", "subscription", "api", "unknown"];
const PRIVACY = ["local", "trusted", "public", "unknown"];
const selectOptions = (values) => values.map((v) => ({ value: v, label: v }));

function Settings(props) {
  const ctx = props.ctx;
  const ui = ctx.ui;
  const [output, setOutput] = createSignal(ctx.t("empty"));
  const [providers, setProviders] = createSignal([]);
  const [examples, setExamples] = createSignal([]);
  const [plan, setPlan] = createSignal("");
  const [planName, setPlanName] = createSignal("");
  const [tasks, setTasks] = createSignal([]);
  const [taskId, setTaskId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [provider, setProvider] = createSignal("");
  const [billing, setBilling] = createSignal("unknown");
  const [privacy, setPrivacy] = createSignal("unknown");
  const [enabled, setEnabled] = createSignal(false);
  const [draft, setDraft] = createSignal({});

  const call = async (name, input, after) => {
    setBusy(true);
    try {
      const result = await ctx.client.rpc(Orchestra)[name](input ?? {});
      setOutput(result.text);
      if (after) after(result.text);
    } catch (error) {
      setOutput(ctx.t("result") + ": " + String(error?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const load = () => {
    call("classify", {}, (text) => {
      try {
        const groups = JSON.parse(text).groups ?? [];
        setProviders(groups);
        const first = groups[0];
        if (first && !provider()) selectProvider(first);
      } catch { setProviders([]); }
    });
    call("examples", {}, (text) => {
      setExamples(text.split("\n---\n").filter(Boolean).map((block) => {
        const i = block.indexOf("\n");
        return { name: block.slice(0, i).replace(".json", ""), content: block.slice(i + 1) };
      }));
    });
    call("status", {}, (text) => {
      try { setTasks(Object.keys(JSON.parse(text).tasks ?? {})); } catch { setTasks([]); }
    });
  };

  const selectProvider = (group) => {
    setProvider(group.provider);
    const d = draft()[group.provider] ?? {
      billing: group.currentPolicy?.billing ?? group.billing.suggested,
      privacy: group.currentPolicy?.privacy ?? "unknown",
      enabled: Boolean(group.currentPolicy?.enabled)
    };
    setBilling(d.billing);
    setPrivacy(d.privacy);
    setEnabled(d.enabled);
  };

  const updateDraft = (patch) => {
    setDraft({ ...draft(), [provider()]: { billing: billing(), privacy: privacy(), enabled: enabled(), ...patch } });
  };

  const confirm = () => {
    call("confirmProvider", { provider: provider(), billing: billing(), privacy: privacy(), enabled: enabled() }, load);
  };

  return (
    <ui.SettingsLayout title={ctx.t("page.title")} description={ctx.t("page.description")}>
      <ui.SettingsSection title={ctx.t("sec.providers")} footer={<ui.Button onClick={load} size="small">{ctx.t("btn.check")}</ui.Button>}>
        <ui.SettingsRow title={ctx.t("field.provider")} description={providers().length + " providers"}>
          <ui.Select
            label={ctx.t("field.provider")}
            options={[{ value: "", label: "—" }, ...providers().map((g) => ({ value: g.provider, label: g.provider }))]}
            value={provider()}
            onChange={(v) => { const g = providers().find((x) => x.provider === v); if (g) selectProvider(g); }}
          />
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("field.billing")}>
          <ui.Select label={ctx.t("field.billing")} options={selectOptions(BILLING)} value={billing()} onChange={(v) => { setBilling(v); updateDraft({ billing: v }); }} />
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("field.privacy")}>
          <ui.Select label={ctx.t("field.privacy")} options={selectOptions(PRIVACY)} value={privacy()} onChange={(v) => { setPrivacy(v); updateDraft({ privacy: v }); }} />
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("field.enabled")}>
          <ui.Switch label={ctx.t("field.enabled")} checked={enabled()} onChange={(v) => { setEnabled(v); updateDraft({ enabled: v }); }} />
        </ui.SettingsRow>
        <ui.SettingsRow title="">
          <ui.Button onClick={confirm} disabled={busy() || !provider()} variant="contrast">{ctx.t("btn.confirm")}</ui.Button>
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("sec.plan")}>
        <For each={examples()}>{(example) => (
          <ui.SettingsRow title={example.name} description={planName() === example.name ? "✓" : ""}>
            <ui.Button onClick={() => { setPlan(example.content); setPlanName(example.name); }} size="small">{planName() === example.name ? "✓" : "→"}</ui.Button>
          </ui.SettingsRow>
        )}</For>
        <ui.SettingsRow title={ctx.t("btn.submit")}>
          <ui.Button onClick={() => call("submitPlan", { plan: plan() }, load)} disabled={busy() || !plan()} variant="contrast">{ctx.t("btn.submit")}</ui.Button>
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("field.task")}>
          <ui.Select label={ctx.t("field.task")} options={[{ value: "", label: "—" }, ...tasks().map((t) => ({ value: t, label: t }))]} value={taskId()} onChange={setTaskId} />
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("btn.pool")}>
          <ui.Button onClick={() => call("pool", {})} disabled={busy()} size="small">{ctx.t("btn.pool")}</ui.Button>
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("btn.preview")}>
          <ui.Button onClick={() => call("routePreview", { taskId: taskId() })} disabled={busy() || !taskId()} size="small">{ctx.t("btn.preview")}</ui.Button>
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("sec.actions")}>
        <ui.SettingsRow title={ctx.t("btn.run")}>
          <ui.Button onClick={() => call("run", {})} disabled={busy()} size="small">{ctx.t("btn.run")}</ui.Button>
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("btn.check")}>
          <ui.Button onClick={() => call("checkUpdate", {})} disabled={busy()} size="small">{ctx.t("btn.check")}</ui.Button>
        </ui.SettingsRow>
        <ui.SettingsRow title={ctx.t("btn.update")}>
          <ui.Button onClick={() => call("update", {})} disabled={busy()} size="small">{ctx.t("btn.update")}</ui.Button>
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("result")}>
        <div style={{ padding: "8px", "white-space": "pre-wrap", "max-height": "200px", overflow: "auto" }}>{output()}</div>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  );
}

function PanelView(props) {
  const ctx = props.ctx;
  const ui = ctx.ui;
  return (
    <div style={{ padding: "12px", display: "flex", "flex-direction": "column", gap: "8px", "max-height": "100%", overflow: "auto" }}>
      <ui.Button variant="contrast" onClick={() => ctx.layout.settings("agentorchestra")}>{ctx.t("menu.open")}</ui.Button>
      <div style={{ "font-size": "12px", opacity: 0.7 }}>{ctx.t("page.description")}</div>
    </div>
  );
}

export default Plugin.define({
  i18n,
  setup(ctx) {
    const rpc = () => ctx.client.rpc(Orchestra);
    const openSettings = () => ctx.layout.settings("agentorchestra");

    ctx.add(SettingsPage, {
      id: "agentorchestra",
      icon: "sparkles",
      get title() { return ctx.t("page.title"); },
      get entries() {
        return [
          { id: "providers", title: ctx.t("sec.providers") },
          { id: "plan", title: ctx.t("sec.plan") },
          { id: "actions", title: ctx.t("sec.actions") }
        ];
      },
      render: () => <Settings ctx={ctx} />
    });

    ctx.add(ComposerPill, {
      id: "orchestra",
      show: () => ({
        label: ctx.t("pill.label"),
        title: ctx.t("pill.title"),
        icon: "sparkles",
        rows: [
          { id: "setup", label: ctx.t("pill.setup"), run: openSettings },
          { id: "plan", label: ctx.t("pill.plan"), run: openSettings },
          { id: "run", label: ctx.t("pill.run"), run: () => void rpc().run({}) },
          { id: "update", label: ctx.t("pill.update"), run: () => void rpc().checkUpdate({}) }
        ]
      })
    });

    ctx.add(Command, {
      id: "open",
      title: ctx.t("command.open"),
      section: "model",
      slash: { name: "orchestra" },
      featured: true,
      run: openSettings
    });

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "open",
      title: ctx.t("menu.open"),
      icon: "sparkles",
      run: openSettings
    });

    ctx.add(Panel, {
      id: "main",
      region: "side",
      width: 360,
      list: (input) => (input.open.includes("main") ? [{
        id: "main",
        get title() { return ctx.t("panel.title"); },
        closable: "compact"
      }] : []),
      render: () => <PanelView ctx={ctx} />
    });
  }
});
