// Paint in the dashboard's mode before React loads: ?theme= on the launch URL, else the last mode this tab saw.
(() => {
  var mode = null;
  try {
    mode = new URLSearchParams(location.search).get("theme");
  } catch {}
  if (mode !== "dark" && mode !== "light") {
    try {
      mode = sessionStorage.getItem("queek-theme");
    } catch {}
  }
  if (mode === "dark") document.documentElement.classList.add("dark");
  try {
    if (mode === "dark" || mode === "light") sessionStorage.setItem("queek-theme", mode);
  } catch {}
})();
