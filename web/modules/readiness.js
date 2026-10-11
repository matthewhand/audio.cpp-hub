/* #122: deferred UI for model-specific alternative instance choices. */
import { $, t } from "./dom.js";
import { go } from "./routing.js";

export function renderReadiness(instances, models, selectedModelId) {
  const has = instances.some(i => i.modelId === selectedModelId && i.status === "READY");
  const context = $("instance-context");
  const selected = models.find(m => m.id === selectedModelId);
  const showContext = !has && !!selected;
  context.classList.toggle("hidden", !showContext);
  if (showContext) {
    const name = I18N.pick(selected, "displayName");
    const others = instances.filter(i => i.status === "READY" && i.modelId !== selectedModelId);
    const options = [...new Map(others.map(i => [i.modelId, i])).entries()]
      .filter(([id]) => models.some(m => m.id === id));
    const key = !others.length ? "none" : options.length ? "others" : "unlisted";
    const values = { model: name, count: others.length };
    for (const [id, value] of [
      ["instance-context-kicker", t("instance.readiness.kicker")],
      ["instance-context-title", t("instance.readiness.title", values)],
      ["instance-context-copy", t("instance.readiness." + key, values)]
    ]) {
      const node = $(id);
      if (node.textContent !== value) node.textContent = value;
    }
    const choices = context.querySelector(".instance-context-choices");
    choices.classList.toggle("hidden", options.length === 0);
    const heading = t("instance.readiness.available");
    choices.querySelector(".instance-context-choices-heading").textContent = heading;
    const list = context.querySelector(".instance-context-options");
    list.setAttribute("aria-label", heading);
    const signature = I18N.lang() + options.map(([id, i]) => id + i.port + i.backend).join("|");
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren();
      for (const [id, inst] of options) {
        const m = models.find(x => x.id === id);
        const modelName = I18N.pick(m, "displayName");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "instance-context-option";
        btn.textContent = t("instance.readiness.choice", {
          model: modelName, backend: inst.backend, port: inst.port
        });
        btn.setAttribute("aria-label", t("instance.readiness.switch", { model: modelName }));
        btn.onclick = () => go("#/model/" + encodeURIComponent(id));
        list.appendChild(btn);
      }
    }
  }
}
