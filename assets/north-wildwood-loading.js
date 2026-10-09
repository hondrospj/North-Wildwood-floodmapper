/* Startup owns the ready signal; this controller only owns the welcome overlay. */
(() => {
  function init() {
    const loader = document.getElementById('nwSiteLoader');
    const app = document.getElementById('app');
    if (!loader || !app) return;
    let finished = false;
    let deadline;
    const background = new Map();
    const observer = new MutationObserver(checkReady);
    app.setAttribute('aria-busy', 'true');
    function isolateControls() {
      // Mobile places its Controls and Key buttons outside the app container.
      for (const id of ['app', 'mobileControlsToggle', 'legendDock']) {
        const element = document.getElementById(id);
        if (!element || background.has(element)) continue;
        background.set(element, element.inert);
        element.inert = true;
      }
    }
    function finish(reason) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      observer.disconnect();
      document.body.dataset.siteLoader = reason;
      document.body.classList.remove('nw-app-loading');
      for (const [element, inert] of background) element.inert = inert;
      app.setAttribute('aria-busy', 'false');
      loader.classList.add('is-fading');
      loader.setAttribute('aria-hidden', 'true');
      const hide = () => { loader.hidden = true; };
      if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) hide();
      else {
        loader.addEventListener('transitionend', hide, {once:true});
        setTimeout(hide, 250);
      }
    }
    function checkReady() {
      if (document.body.classList.contains('nw-app-ready')) finish('complete');
      else if (!finished) isolateControls();
    }
    observer.observe(document.body, {attributes:true, attributeFilter:['class']});
    // Release the interface even if an external library or request never finishes.
    deadline = setTimeout(() => finish('timeout'), 20000);
    checkReady();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
