// Acceptance-only instrumentation; not loaded by the product. Element Timing
// reports Chrome's text paint, rather than the polling time of a DOM assertion.
export async function installFirstAssistantTextTiming(page) {
  await page.evaluate(`(() => {
    if (!PerformanceObserver.supportedEntryTypes.includes('element'))
      throw new Error('This acceptance requires Chrome Element Timing');
    const sample = window.piCloudFirstTextTiming = {};
    const selector = '.product-agent-answer .product-markdown';
    const clicked = event => {
      if (sample.submittedAt === undefined && event.target.closest('.product-send-button')) {
        sample.submittedAt = performance.now(); sample.submittedWallAt = Date.now();
      }
    };
    document.addEventListener('click', clicked, true);
    const mutations = new MutationObserver(() => {
      if (sample.submittedAt === undefined) return;
      for (const block of document.querySelectorAll(selector + ' p, ' + selector + ' li, ' + selector + ' pre')) {
        if (!block.textContent.trim()) continue;
        sample.firstDomAt ??= performance.now();
        block.setAttribute('elementtiming', 'pi-cloud-first-assistant');
      }
    });
    mutations.observe(document.body, { childList:true, characterData:true, subtree:true });
    const paints = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.identifier !== 'pi-cloud-first-assistant' || entry.renderTime < sample.submittedAt ||
            entry.intersectionRect.width === 0 || entry.intersectionRect.height === 0) continue;
        sample.firstPaintAt ??= entry.renderTime;
        sample.paintObservedAt ??= performance.now();
      }
      if (sample.firstPaintAt !== undefined) {
        mutations.disconnect(); paints.disconnect(); document.removeEventListener('click', clicked, true);
      }
    });
    paints.observe({type:'element', buffered:true});
  })()`);
}

export async function firstAssistantTextTiming(page) {
  await page.waitFor("window.piCloudFirstTextTiming?.firstPaintAt !== undefined");
  return page.evaluate(`(() => {
    const s = window.piCloudFirstTextTiming;
    return { submittedWallAt:s.submittedWallAt,
      userClickToFirstDomMs:s.firstDomAt-s.submittedAt,
      userClickToFirstTextPaintMs:s.firstPaintAt-s.submittedAt,
      domToFirstTextPaintMs:s.firstPaintAt-s.firstDomAt,
      measurement:'Chrome Element Timing text-paint; one browser monotonic clock; headless rendering' };
  })()`);
}
