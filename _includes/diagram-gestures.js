// Website-only camera, inlined into diagrams/<slug>/embed/ inside the isolated iframe.
(() => {
  if (window.parent === window) return;
  const root = document.documentElement;
  const diagram = document.querySelector('#diagram');
  if (!diagram) return;
  const canvas = document.createElement('div');
  canvas.className = 'diagram-camera';
  const padding = getComputedStyle(document.body).padding;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:max-content;padding:${padding};transform-origin:0 0;transform:matrix(1,0,0,1,0,0);`;
  // Keep loading and offscreen rendering outside the camera.
  // The legend belongs to #diagram; the wording selector is inserted by its heading.
  for (const node of document.querySelectorAll('#page-heading, #diagram')) canvas.append(node);
  document.body.append(canvas);
  document.body.style.padding = '0';
  const style = document.createElement('style');
  style.textContent = `
    html, body { overflow: hidden !important; overscroll-behavior: none; scrollbar-width: none; }
    html { touch-action: none; }
    body { position: fixed; inset: 0; margin: 0; overflow: clip !important; }
    .inspection-box { touch-action: pan-x pan-y; }
    @media (hover: none) {
      .inspection-box-lock { display: none !important; }
      .inspection-box-head {
        display: grid; grid-template-columns: minmax(0, 1fr) 28px;
        align-items: center; column-gap: 8px; padding-bottom: 8px !important;
      }
      .inspection-box-header {
        grid-column: 1; grid-row: 1; min-width: 0; margin-bottom: 0 !important;
      }
      .inspection-box-controls {
        grid-column: 2; grid-row: 1; min-height: 28px;
        padding-right: 0 !important; margin-bottom: 0 !important;
      }
      .inspection-box-close { right: 0 !important; }
    }
    html[data-diagram-panning], html[data-diagram-panning] * {
      cursor: grabbing !important; user-select: none !important;
    }
  `;
  document.head.append(style);

  // The entire view is one affine transform: screen = scale * diagram + offset.
  // Neither native scroll offsets nor parent-frame acknowledgements participate.
  let scale = 1, x = 0, y = 0, paintedScale = 1, paintedX = 0, paintedY = 0;
  let paintFrame = 0, rasterEnd = 0, controlId;
  let centered = null, wheelZoom = null, pinch = null, touch = null, pan = null;
  let width = 0, height = 0;
  let suppressPanClick = false;
  let lastWheelZoom = -Infinity;
  let ready = false;
  let inspectionPointer = null;
  const send = data => window.parent.postMessage(data, '*');
  const clamp = value => Math.max(.1, Math.min(4, value));
  const pointInDiagram = point => ({ x: (point.x - x) / scale, y: (point.y - y) / scale });
  const changed = () => send({ type: 'diagram:zoom-changed', scale, controlId });
  const constrain = () => {
    // A small diagram stays at the top/left; spare space to its right/bottom
    // remains visible. Overlays must not enlarge the diagram's pan limits.
    x = Math.max(Math.min(0, innerWidth - width * scale), Math.min(0, x));
    y = Math.max(Math.min(0, innerHeight - height * scale), Math.min(0, y));
  };
  // The renderer lays out body overlays against the unzoomed viewport. Fit new
  // boxes in diagram units instead, then let them inherit the camera transform.
  // Keep the opening viewport so later content arriving cannot undo a user's pan
  // or zoom. These dimensions match the exported renderer's boxWidths/Placement.
  const observeBoxes = () => {
    for (const node of document.body.querySelectorAll(':scope > .inspection-box')) {
      const visible = window.visualViewport;
      const viewport = {
        left: ((visible?.offsetLeft ?? 0) - paintedX) / paintedScale,
        top: ((visible?.offsetTop ?? 0) - paintedY) / paintedScale,
        width: (visible?.width ?? innerWidth) / paintedScale,
        height: (visible?.height ?? innerHeight) / paintedScale,
      };
      const pointer = inspectionPointer ?? {
        x: (parseFloat(node.style.left) - paintedX) / paintedScale,
        y: (parseFloat(node.style.top) - paintedY) / paintedScale,
      };
      const wrapper = document.createElement('div');
      wrapper.className = 'diagram-inspection-anchor';
      wrapper.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483000;';
      const setSize = (property, value) => {
        const previous = parseFloat(node.style[property]);
        // CSS serialises fractional sizes with limited precision. Avoid a style
        // observer loop when a wheel gesture produces a non-round zoom factor.
        if (!Number.isFinite(previous) || Math.abs(previous - value) > .01) node.style[property] = `${value}px`;
      };
      const along = (point, extent, start, size, flip) => {
        const first = start + 8, last = start + size - 8;
        if (point + 2 + extent <= last) return point + 2;
        if (flip && point - 2 - extent >= first) return point - 2 - extent;
        return Math.max(first, last - extent);
      };
      const place = () => {
        const left = parseFloat(node.style.left), top = parseFloat(node.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;
        const css = getComputedStyle(node);
        const borders = parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth);
        const padding = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
        const room = Math.max(0, viewport.width - 16);
        setSize('maxHeight', Math.max(0, Math.min(viewport.height * .8, viewport.height - 16)));
        const scrollbar = Math.max(0, node.offsetWidth - borders - node.clientWidth);
        setSize('width', Math.min(room, 1000 + padding + borders + scrollbar));
        // Subtract the renderer's left/top in the wrapper, leaving its placement
        // writes intact while positioning the box beside the actual opening tap.
        wrapper.style.left = `${along(pointer.x, node.offsetWidth, viewport.left, viewport.width, false) - left}px`;
        wrapper.style.top = `${along(pointer.y, node.offsetHeight, viewport.top, viewport.height, true) - top}px`;
      };
      place();
      wrapper.append(node);
      canvas.append(wrapper);
      const observer = new MutationObserver(() => {
        if (node.parentElement !== wrapper) {
          observer.disconnect();
          wrapper.remove();
        } else place();
      });
      observer.observe(node, { attributes: true, attributeFilter: ['style'] });
      observer.observe(wrapper, { childList: true });
    }
  };
  new MutationObserver(observeBoxes).observe(document.body, { childList: true });
  observeBoxes();
  const paint = () => {
    paintFrame = 0;
    observeBoxes();
    // One style mutation commits scale and translation together, before paint.
    canvas.style.willChange = 'transform';
    canvas.style.transform = `matrix(${scale},0,0,${scale},${x},${y})`;
    paintedScale = scale;
    paintedX = x;
    paintedY = y;
    // Let the browser rasterise text at the final scale once movement stops.
    clearTimeout(rasterEnd);
    rasterEnd = setTimeout(() => { canvas.style.willChange = 'auto'; }, 180);
    changed();
  };
  const schedulePaint = () => { if (!paintFrame) paintFrame = requestAnimationFrame(paint); };
  const zoom = (next, point, anchor = pointInDiagram(point)) => {
    scale = clamp(next);
    x = point.x - scale * anchor.x;
    y = point.y - scale * anchor.y;
    // Clamp only the rendered translation, never the saved zoom anchor. Each
    // constrained axis follows its edge until the original anchor fits again.
    constrain();
    schedulePaint();
  };
  const move = (dx, dy) => {
    centered = null;
    wheelZoom = null;
    x += dx;
    y += dy;
    constrain();
    schedulePaint();
  };
  const interactive = target => target instanceof Element &&
    target.closest('input, textarea, select, button, a, [contenteditable], [role="slider"], .inspection-box');

  // The existing renderer hit-tests inspection regions in unscaled local units.
  // Adapt main and nested diagrams; save the real pointer before changing the
  // hit-test coordinates so new boxes open at the correct diagram point.
  for (const type of ['pointermove', 'click']) canvas.addEventListener(type, event => {
    const container = event.target instanceof Element && event.target.closest('#diagram, .inspection-box-diagram');
    if (!container) return;
    inspectionPointer = { x: (event.clientX - paintedX) / paintedScale,
      y: (event.clientY - paintedY) / paintedScale };
    const bounds = container.getBoundingClientRect();
    Object.defineProperties(event, {
      clientX: { value: bounds.left + (event.clientX - bounds.left) / paintedScale },
      clientY: { value: bounds.top + (event.clientY - bounds.top) / paintedScale },
    });
  }, { capture: true });

  const finishPan = () => {
    if (!pan) return;
    const id = pan.id;
    suppressPanClick = pan.button === 0 && pan.active;
    pan = null;
    root.removeAttribute('data-diagram-panning');
    if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
  };
  document.addEventListener('pointerdown', event => {
    suppressPanClick = false;
    if (!ready || pan || ![0, 1].includes(event.button) || event.pointerType !== 'mouse' ||
        (event.button === 0 && interactive(event.target))) return;
    pan = { id: event.pointerId, button: event.button, active: false,
      x: event.clientX, y: event.clientY };
    // Leave a primary click untouched for renderer inspection/locking. Capture
    // only once a drag starts, so buttons, links and simple clicks still work.
    if (event.button === 1) event.preventDefault();
  }, { capture: true });
  document.addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.id) return;
    if (!(event.buttons & (pan.button === 0 ? 1 : 4))) { finishPan(); return; }
    const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
    if (!pan.active) {
      if (Math.hypot(dx, dy) < 4) return;
      pan.active = true;
      root.setAttribute('data-diagram-panning', '');
      root.setPointerCapture(event.pointerId);
      lastWheelZoom = -Infinity;
      window.focus();
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    move(dx, dy);
    pan.x = event.clientX;
    pan.y = event.clientY;
  }, { capture: true });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
    if (pan?.id === event.pointerId) finishPan();
  });
  document.addEventListener('click', event => {
    if (!suppressPanClick || event.detail === 0) return;
    suppressPanClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  document.addEventListener('dragstart', event => {
    if (pan) event.preventDefault();
  }, { capture: true });
  for (const type of ['mousedown', 'auxclick']) document.addEventListener(type, event => {
    if (event.button === 1) event.preventDefault();
  }, { capture: true });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { finishPan(); return; }
    if (!ready || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || interactive(event.target)) return;
    const direction = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    move(direction[0] * 60, direction[1] * 60);
  });

  document.addEventListener('wheel', event => {
    if (!ready || (!event.ctrlKey && event.target instanceof Element &&
        event.target.closest('.inspection-box, input, textarea, select'))) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    if (event.ctrlKey) {
      finishPan();
      centered = null;
      controlId = undefined;
      lastWheelZoom = performance.now();
      const point = { x: event.clientX, y: event.clientY };
      if (!wheelZoom || wheelZoom.point.x !== point.x || wheelZoom.point.y !== point.y) {
        wheelZoom = { point, anchor: pointInDiagram(point) };
      }
      zoom(scale * Math.exp(-event.deltaY * unit * .01), point, wheelZoom.anchor);
    } else if (performance.now() - lastWheelZoom >= 220) {
      move(-event.deltaX * unit, -event.deltaY * unit);
    }
  }, { passive: false, capture: true });

  const midpoint = touches => ({ x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2 });
  const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY);
  const startTouch = event => {
    pinch = null;
    touch = null;
    if (!ready || interactive(event.target)) return;
    centered = null;
    wheelZoom = null;
    lastWheelZoom = -Infinity;
    if (event.touches.length === 2) {
      event.preventDefault();
      const point = midpoint(event.touches);
      pinch = { point, anchor: pointInDiagram(point), scale, distance: Math.max(1, distance(event.touches)) };
    } else if (event.touches.length === 1) {
      touch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
  };
  document.addEventListener('touchstart', startTouch, { passive: false });
  document.addEventListener('touchmove', event => {
    if (pinch && event.touches.length === 2) {
      event.preventDefault();
      controlId = undefined;
      zoom(pinch.scale * distance(event.touches) / pinch.distance, pinch.point, pinch.anchor);
    } else if (touch && event.touches.length === 1) {
      event.preventDefault();
      const next = event.touches[0];
      move(next.clientX - touch.x, next.clientY - touch.y);
      touch = { x: next.clientX, y: next.clientY };
    }
  }, { passive: false });
  document.addEventListener('touchend', startTouch, { passive: false });
  const cancel = () => { finishPan(); pinch = null; touch = null; };
  document.addEventListener('touchcancel', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', () => {
    centered = null;
    wheelZoom = null;
    cancel();
    if (ready) { constrain(); schedulePaint(); }
  });
  const measure = () => {
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
    if (ready) { constrain(); schedulePaint(); }
  };
  new ResizeObserver(measure).observe(canvas);

  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.type === 'diagram:connect') {
      if (ready) { send({ type: 'diagram:controls-ready' }); changed(); }
    } else if (data.type === 'diagram:pan-end') {
      finishPan();
    } else if (ready && data.type === 'diagram:zoom-center' && Number.isFinite(data.scale)) {
      cancel();
      wheelZoom = null;
      const point = { x: innerWidth / 2, y: innerHeight / 2 };
      centered ??= pointInDiagram(point);
      controlId = data.controlId;
      zoom(data.scale, point, centered);
    }
  });
  // Do not transform the diagram until the renderer has finished measuring it.
  const announce = () => {
    if (!window.tsncd) { setTimeout(announce, 100); return; }
    ready = true;
    measure();
    send({ type: 'diagram:controls-ready' });
    changed();
  };
  announce();
})();
