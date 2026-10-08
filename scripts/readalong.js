// Read-along for the samples on this page: the sentence being spoken is
// marked, and a click on any sentence plays from it. No dependencies; the
// times sit in each sentence's data attributes.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const box of document.querySelectorAll('.readalong')) {
    const audio = document.getElementById(box.dataset.audio);
    if (!audio) continue;
    const lines = Array.from(box.querySelectorAll('a.s'));
    const starts = lines.map((a) => Number(a.dataset.s));
    let current = -1;

    // The last sentence that has started.
    const at = (t) => {
      let lo = 0;
      let hi = starts.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= t + 0.05) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return found;
    };

    const show = () => {
      const i = at(audio.currentTime);
      if (i === current) return;
      if (lines[current]) {
        lines[current].classList.remove('on');
        lines[current].removeAttribute('aria-current');
      }
      current = i;
      const el = lines[i];
      if (!el) return;
      el.classList.add('on');
      el.setAttribute('aria-current', 'true');
      // Keep the sentence in view inside the script box, not by moving the page.
      if (!audio.paused && box.closest('details')?.open) {
        const top = el.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) {
          box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: reduce ? 'auto' : 'smooth' });
        }
      }
    };

    const playFrom = (t) => {
      const go = () => {
        audio.currentTime = t;
        audio.play().catch(() => undefined);
      };
      if (audio.readyState >= 1) go();
      else {
        audio.preload = 'auto';
        audio.addEventListener('loadedmetadata', go, { once: true });
        audio.load();
      }
    };

    audio.addEventListener('timeupdate', show);
    audio.addEventListener('seeked', show);
    box.addEventListener('click', (e) => {
      const a = e.target.closest('a.s');
      if (!a) return;
      e.preventDefault();
      playFrom(Number(a.dataset.s));
    });
  }
})();
