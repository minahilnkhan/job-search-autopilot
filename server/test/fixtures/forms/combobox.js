// Minimal stand-in for react-select (what Greenhouse's new forms use):
// typing opens a listbox of role=option items; clicking one shows it as the value.
document.querySelectorAll("[data-options]").forEach((input) => {
  const control = input.closest(".select__control");
  const shown = control.querySelector(".select__single-value");
  const list = document.createElement("div");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  control.after(list);
  const render = () => {
    list.innerHTML = "";
    const q = input.value.toLowerCase();
    for (const o of input.dataset.options.split("|").filter((o) => o.toLowerCase().includes(q))) {
      const d = document.createElement("div");
      d.setAttribute("role", "option");
      d.textContent = o;
      d.addEventListener("click", () => { shown.textContent = o; input.value = ""; list.hidden = true; input.dataset.chosen = o; });
      list.append(d);
    }
    list.hidden = false;
  };
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
});
document.querySelectorAll("form").forEach((f) => f.addEventListener("submit", (e) => { e.preventDefault(); window.__submitted = true; }));
document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { window.__clicked = (window.__clicked || 0) + 1; }));
