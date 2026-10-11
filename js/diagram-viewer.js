// Interactive diagram viewer: model and variant selectors, the pass symbols
// (decode and cached), the ℝ/FP toggle between a model in the reals and at its
// number formats, forms, themes, zoom, sharing and the expanded view. Markup: _includes/diagram-viewer.html. The
// diagram runs in a sandboxed iframe (diagrams/<slug>/embed/) whose bridge,
// _includes/diagram-gestures.js, owns panning and zooming; this script only
// exchanges messages with the bridge and with the export.
//
// A full-page viewer's address names the view on screen: the variant in its
// path, /diagrams/<slug>/<variant>/, and the form and the theme in its query,
// ?form=<form>&theme=<dark|light>. The address alone decides the view a page
// opens. An address that names no form opens all broadcasted, and one that
// names no theme follows the reader's system theme, as it changes, until the
// reader switches something. Every switch of variant, model, form or theme
// writes both the form and the theme into the address, and the variant into
// its path, so a copied address or the share link reproduces the view. An
// address that sets the form or the theme to a value the diagram cannot be
// drawn in, or sets any other parameter, opens no diagram, and the stage says
// which parameter, which value and which values the diagram accepts. A variant
// the export does not carry has no page. The parameters that sites add to a
// shared link to track it (TRACKING_PARAMETERS) are not part of the link: they
// are not refused, the address drops them, and the iframe never receives them.
//
// The iframe's address carries controls=hidden, form, darkMode and, for an
// export with variants, variant, so the toolbar is the only one on screen.
// Messages to the export:
//   {type: 'tsncd-display', variant?, form?, darkMode?}
// Messages from the export:
//   {type: 'tsncd-state', variant, form, darkMode, variants, groups}, once it
//     has read its variants and after every switch. The toolbar and the
//     address follow it. The variants themselves are read from the catalogue
//     the build wrote from the same export.
//   {type: 'tsncd-refused', parameter, value, accepted}, when its address or a
//     message names something it does not have.
(() => {
  const SANDBOX = 'allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox';
  const FORMS = ['arrows-and-boxes', 'arrows-and-broadcasted', 'all-broadcasted'];
  const THEMES = ['dark', 'light'];
  const UNNAMED_FORM = 'all-broadcasted';
  const VIEWER_PARAMETERS = ['form', 'theme'];
  const TRACKING_PARAMETERS = ['fbclid', 'gclid', 'mc_cid', 'mc_eid'];
  const isTracking = parameter => parameter.startsWith('utm_') || TRACKING_PARAMETERS.includes(parameter);
  const CANVAS = { dark: '#1e1e1e', light: '#ffffff' };
  // The export's text colour on each canvas, for the loading screen drawn over it.
  const INK = { dark: '#dedede', light: '#000000' };
  // What the loading screen says while the export switches to the quantisation
  // named, from the other one.
  const QUANTISATION_LOADING = {
    unquantised: 'Applying Dequantization Functor...',
    quantised: 'Loading the Quantized Form...',
  };
  // The include's inline script reads the address and the same media query to
  // colour the stage before its first paint.
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const systemTheme = () => (systemDark.matches ? 'dark' : 'light');

  const quoted = value => `\u201c${value}\u201d`;
  const alternatives = values => (values.length < 2 ? values.join('')
    : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`);

  for (const viewer of document.querySelectorAll('.diagram-viewer')) setUp(viewer);

  function setUp(viewer) {
    const inline = viewer.dataset.mode === 'inline';
    const base = viewer.dataset.base;
    const models = new Map(JSON.parse(viewer.querySelector('.diagram-catalogue').textContent)
      .map(model => [model.slug, model]));
    const stage = viewer.querySelector('.viewer-stage');
    const selector = viewer.querySelector('.diagram-selector');
    const summary = selector.querySelector('summary');
    const options = selector.querySelectorAll('a[data-slug]');
    const variantSelector = viewer.querySelector('.variant-selector');
    const variantSummary = variantSelector.querySelector('summary');
    const variantPanel = variantSelector.querySelector('.variant-options');
    const passBar = viewer.querySelector('.diagram-passes');
    const passButtons = passBar.querySelectorAll('[data-pass]');
    const quantisationBar = viewer.querySelector('.diagram-quantisation');
    const quantisationButtons = quantisationBar.querySelectorAll('[data-quantisation]');
    const controls = viewer.querySelector('.viewer-controls');
    const zoomBar = viewer.querySelector('.diagram-zoom');
    const zoomButtons = zoomBar.querySelectorAll('[data-zoom]');
    const zoomSlider = zoomBar.querySelector('input');
    const zoomReset = zoomBar.querySelector('[data-zoom="reset"]');
    const share = viewer.querySelector('.diagram-share');
    const notebook = viewer.querySelector('.diagram-notebook');
    const toggle = viewer.querySelector('.diagram-expand');
    const poster = stage.querySelector('.viewer-poster');
    const formsBar = viewer.querySelector('.diagram-forms');
    const formButtons = formsBar.querySelectorAll('[data-form]');
    const themeButton = viewer.querySelector('.diagram-theme');
    // The ℝ/FP toggle and the form buttons, each drawn as a dropdown on a phone.
    const menus = viewer.querySelectorAll('.control-menu');
    let frame = null;
    // What the export last reported drawing, once it has reported.
    let drawn = null;
    // Set while the stage shows why the view cannot be drawn.
    let refused = false;
    let scale = 1;
    let sliderRequest = null;
    let nextSliderRequest = 0;

    // The view on screen. `variant` is null for an export that carries one figure.
    const view = { slug: viewer.dataset.slug, variant: viewer.dataset.variant || null, form: null, theme: null };
    const current = () => models.get(view.slug);
    // Whether the address names the form and the theme. A switch names both.
    const named = { form: false, theme: false };
    const nameView = () => { named.form = true; named.theme = true; };

    controls.hidden = false;
    zoomBar.hidden = true;

    const send = message => {
      // The sandboxed frame has an opaque origin; replies are checked by source.
      frame?.contentWindow?.postMessage(message, '*');
    };

    // Forms and themes. An export that can switch them (model.forms, found at
    // build time) is drawn in any of them, all broadcasted and in the system
    // theme where the address names neither. Other exports are drawn only in
    // the form and the theme they were exported in (model.form, model.dark).
    const exportedTheme = model => (model.dark ? 'dark' : 'light');
    const acceptedForms = model => (model.forms ? FORMS : [model.form]);
    const acceptedThemes = model => (model.forms ? THEMES : [exportedTheme(model)]);
    const unnamedForm = model => (model.forms ? UNNAMED_FORM : model.form);
    const unnamedTheme = model => (model.forms ? systemTheme() : exportedTheme(model));
    // The stage behind the frame is the diagram's canvas, so a diagram that is
    // still loading stands on its own colour.
    const canvasOf = model => (model.forms ? CANVAS[view.theme] : model.canvas);
    const inkOf = model => ((model.forms ? view.theme : exportedTheme(model)) === 'dark' ? INK.dark : INK.light);
    // The preview is captured in each theme an export can be drawn in.
    const posterOf = model => `${base}${model.slug}/thumbnail${view.theme === exportedTheme(model) ? '' : `-${view.theme}`}.jpg`;

    // Variants, recorded on each model by _plugins/diagrams.rb.
    const variantsOf = model => model.variants ?? [];
    const findVariant = (model, id) => variantsOf(model).find(variant => variant.id === id);
    const groupOf = (model, variant) => (model.variant_groups ?? []).find(group => group.id === variant.group);
    // A quantised variant and its unquantised form (variant.counterpart) are one
    // choice of the variant selector where they are all their group holds
    // (group.paired), and the ℝ/FP toggle picks between them. The reader's last
    // choice of the two holds for every pass and every model that has both.
    let quantisation = null;
    const inQuantisation = (model, id) => {
      const variant = findVariant(model, id);
      return variant?.counterpart && quantisation && variant.quantisation !== quantisation ? variant.counterpart : id;
    };
    const choiceCount = model => variantsOf(model).length - (model.variant_groups ?? []).filter(group => group.paired).length;

    // Addresses: /diagrams/<slug>/, then the variant, then expanded/, then the
    // form and the theme for an export that can switch them. The address, the
    // share link and the inline viewer's links to its page name the form and
    // the theme where the address named them or a switch set them. A variant
    // or model link is a switch, so it names both.
    const isExpanded = () => viewer.classList.contains('is-expanded');
    const pathOf = (slug, variant, expanded) => `${base}${slug}/${variant ? `${variant}/` : ''}${expanded ? 'expanded/' : ''}`;
    const queryOf = parameters => {
      const text = new URLSearchParams(parameters).toString();
      return text ? `?${text}` : '';
    };
    const switchQuery = () => (current().forms ? queryOf({ form: view.form, theme: view.theme }) : '');
    const addressQuery = () => (current().forms ? queryOf({
      ...(named.form ? { form: view.form } : {}), ...(named.theme ? { theme: view.theme } : {}),
    }) : '');

    // Writes the view on screen into the address bar, the share button and
    // every link that opens it.
    function publishView() {
      const model = current();
      const path = pathOf(view.slug, view.variant, isExpanded());
      // A refused address keeps its query, so the reader sees what it named.
      if (!inline) history.replaceState(history.state, '', `${path}${refused ? location.search : addressQuery()}${location.hash}`);
      // Shared links always use the production address, even when testing locally.
      share.dataset.shareUrl = new URL(`${path}${addressQuery()}`, viewer.dataset.origin).href;
      share.dataset.shareTitle = model.title;
      for (const option of variantPanel.querySelectorAll('a[data-variant]')) {
        option.href = `${pathOf(view.slug, option.dataset.variant, isExpanded())}${switchQuery()}`;
      }
      for (const option of options) {
        const target = models.get(option.dataset.slug);
        const carries = model.forms && target?.forms;
        // Another model opens on its first variant, in the quantisation on screen.
        const opening = target?.initial_variant ? inQuantisation(target, target.initial_variant) : null;
        const segment = opening !== target?.initial_variant ? opening : null;
        option.href = `${pathOf(option.dataset.slug, segment, isExpanded())}${carries ? switchQuery() : ''}`;
      }
      if (inline) {
        const page = `${pathOf(view.slug, view.variant, false)}${addressQuery()}`;
        // Expand opens /diagrams/see-diagrams/ on the default diagram's first
        // variant, and the page of the view the reader picked otherwise, which
        // that address would not open.
        const opening = view.slug === viewer.dataset.default && (!view.variant || view.variant === model.initial_variant);
        toggle.href = opening ? `${base}see-diagrams/${addressQuery()}` : page;
        poster?.querySelector('.load-diagram').setAttribute('href', page);
      }
    }

    // Marks the view on screen in the toolbar.
    function showDisplay() {
      const model = current();
      formsBar.hidden = !model.forms;
      themeButton.hidden = !model.forms;
      formButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.form === view.form)));
      const dark = view.theme === 'dark';
      themeButton.setAttribute('aria-pressed', String(dark));
      themeButton.title = `Switch to the ${dark ? 'light' : 'dark'} theme`;
      viewer.style.setProperty('--dv-canvas', canvasOf(model));
      viewer.style.setProperty('--dv-canvas-ink', inkOf(model));
      const image = poster?.querySelector('img');
      if (image && image.getAttribute('src') !== posterOf(model)) image.src = posterOf(model);
      showVariant(model);
      menus.forEach(showMenuChoice);
    }

    // A phone's dropdown shows the icon of its pressed option in its summary.
    function showMenuChoice(menu) {
      const pressed = menu.querySelector('.control-menu-options [aria-pressed="true"]');
      if (!pressed) return;
      const icon = pressed.querySelector('.control-menu-icon');
      menu.querySelector('.control-menu-current').replaceChildren(...[...icon.childNodes].map(node => node.cloneNode(true)));
      const choice = pressed.querySelector('.option-title').textContent;
      menu.querySelector('summary').setAttribute('aria-label', `${menu.dataset.label}. Showing ${choice}`);
    }

    function showVariant(model) {
      variantSelector.hidden = choiceCount(model) < 2 || Boolean(model.pass_symbols);
      passBar.hidden = !model.pass_symbols;
      const variant = findVariant(model, view.variant);
      quantisationBar.hidden = !variant?.counterpart;
      if (!variant) return;
      if (variant.quantisation) quantisation = variant.quantisation;
      showPasses(model, variant);
      quantisationButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.quantisation === variant.quantisation)));
      const group = groupOf(model, variant);
      const paired = Boolean(group?.paired);
      const shown = paired ? group.title : `${group ? `${group.title}, ` : ''}${variant.title}`;
      variantSummary.querySelector('.variant-group').textContent = paired ? '' : group?.title ?? '';
      variantSummary.querySelector('.variant-title').textContent = paired ? group.title : variant.title;
      variantSummary.setAttribute('aria-label', `Choose a variant. Showing ${shown}`);
      // A paired group's choice opens the member in the quantisation on screen.
      for (const option of variantPanel.querySelectorAll('a[data-group]')) {
        const member = findVariant(model, inQuantisation(model, option.dataset.variant));
        option.dataset.variant = member.id;
        const detail = option.querySelector('.option-detail');
        detail.textContent = member.detail ?? '';
        detail.hidden = !member.detail;
      }
      for (const option of variantPanel.querySelectorAll('a[data-variant]')) {
        if (option.dataset.variant === variant.id) option.setAttribute('aria-current', 'true');
        else option.removeAttribute('aria-current');
      }
    }

    // The passes drawn as symbols (model.pass_symbols). A pass opens in the
    // quantisation on screen, and its button and option say what that variant draws.
    const passMember = (model, group) => {
      const first = variantsOf(model).find(member => member.group === group);
      return first && findVariant(model, inQuantisation(model, first.id));
    };
    function showPasses(model, variant) {
      if (!model.pass_symbols) return;
      for (const button of passButtons) {
        const group = (model.variant_groups ?? []).find(candidate => candidate.id === button.dataset.pass);
        button.hidden = !group;
        button.setAttribute('aria-pressed', String(button.dataset.pass === variant.group));
        if (!group) continue;
        const detail = passMember(model, group.id)?.detail ?? '';
        const title = button.querySelector('.option-title');
        if (title) {
          // An option of the phone's dropdown.
          title.textContent = group.title;
          const line = button.querySelector('.option-detail');
          line.textContent = detail;
          line.hidden = !detail;
        } else {
          button.setAttribute('aria-label', group.title);
          button.title = detail ? `${group.title}: ${detail}` : group.title;
        }
      }
    }

    // One link to a variant's page, with its detail under its title.
    function variantOption(variant, titleText, group) {
      const link = document.createElement('a');
      link.dataset.variant = variant.id;
      if (group) link.dataset.group = group.id;
      const title = document.createElement('span');
      title.className = 'option-title';
      title.textContent = titleText;
      const detail = document.createElement('span');
      detail.className = 'option-detail';
      detail.textContent = variant.detail ?? '';
      detail.hidden = !variant.detail;
      link.append(title, detail);
      const item = document.createElement('li');
      item.append(link);
      return item;
    }

    // One list per group, in the order the export gives. A paired group is one
    // choice named by the group's title, and paired groups in a row share a
    // list with no label, as Decode and Cached do.
    function writeVariantOptions(model) {
      variantPanel.replaceChildren();
      let pairs = null;
      for (const group of model.variant_groups ?? []) {
        const members = variantsOf(model).filter(member => member.group === group.id);
        if (group.paired) {
          if (!pairs) {
            pairs = document.createElement('ul');
            variantPanel.append(pairs);
          }
          pairs.append(variantOption(findVariant(model, inQuantisation(model, members[0].id)), group.title, group));
          continue;
        }
        pairs = null;
        const label = document.createElement('p');
        label.className = 'diagram-options-group';
        label.textContent = group.title;
        label.setAttribute('aria-hidden', 'true');
        const list = document.createElement('ul');
        list.setAttribute('aria-label', group.title);
        for (const variant of members) list.append(variantOption(variant, variant.title));
        variantPanel.append(label, list);
      }
    }

    // A switch between a quantised variant and its unquantised form is covered
    // by a loading screen drawn like the export's own, which says which way the
    // switch goes (QUANTISATION_LOADING), until the export reports the variant
    // asked for last as drawn. `loading` is that variant and the screen.
    let loading = null;
    function showLoading(id, text) {
      if (!loading) {
        const node = document.createElement('div');
        node.className = 'viewer-loading';
        node.setAttribute('role', 'status');
        const ring = document.createElement('div');
        ring.className = 'viewer-loading-ring';
        const line = document.createElement('p');
        line.className = 'viewer-loading-text';
        node.append(ring, line);
        stage.append(node);
        loading = { node };
      }
      loading.variant = id;
      loading.node.querySelector('.viewer-loading-text').textContent = text;
    }
    function hideLoading() {
      loading?.node.remove();
      loading = null;
    }

    // The export redraws in place when it receives a `tsncd-display` message.
    function chooseVariant(id) {
      const model = current();
      const next = findVariant(model, id);
      if (id === view.variant || !next) return;
      const previous = findVariant(model, view.variant);
      if (frame && next.quantisation && previous?.quantisation && next.quantisation !== previous.quantisation) {
        showLoading(id, QUANTISATION_LOADING[next.quantisation]);
      } else if (loading) {
        // Another variant asked for mid-switch replaces the one awaited.
        loading.variant = id;
      }
      view.variant = id;
      nameView();
      showDisplay();
      publishView();
      send({ type: 'tsncd-display', variant: id });
    }
    // A pass symbol opens that pass in the quantisation on screen.
    for (const button of passButtons) {
      button.addEventListener('click', () => {
        const member = passMember(current(), button.dataset.pass);
        if (member) chooseVariant(member.id);
      });
    }
    // ℝ and FP switch to the other member of the variant's pair.
    for (const button of quantisationButtons) {
      button.addEventListener('click', () => {
        const variant = findVariant(current(), view.variant);
        if (variant?.counterpart && variant.quantisation !== button.dataset.quantisation) chooseVariant(variant.counterpart);
      });
    }
    for (const button of formButtons) {
      button.addEventListener('click', () => {
        view.form = button.dataset.form;
        nameView();
        showDisplay();
        publishView();
        send({ type: 'tsncd-display', form: view.form });
      });
    }
    themeButton.addEventListener('click', () => {
      view.theme = view.theme === 'dark' ? 'light' : 'dark';
      nameView();
      showDisplay();
      publishView();
      send({ type: 'tsncd-display', darkMode: view.theme === 'dark' });
    });
    // Until the address names a theme, the view follows the system theme.
    systemDark.addEventListener('change', () => {
      if (named.theme || refused || !current().forms) return;
      view.theme = systemTheme();
      showDisplay();
      publishView();
      send({ type: 'tsncd-display', darkMode: view.theme === 'dark' });
    });

    // The export reports what it draws, and the toolbar and the address follow.
    // A value this viewer has no page or button for is left as it is. A change
    // the viewer did not ask for is a switch, so the address names it.
    function followExport(state) {
      if (loading && state.variant === loading.variant) hideLoading();
      const model = current();
      const reported = { variant: view.variant, form: view.form, theme: view.theme };
      if (findVariant(model, state.variant)) reported.variant = state.variant;
      if (acceptedForms(model).includes(state.form)) reported.form = state.form;
      if (typeof state.darkMode === 'boolean') reported.theme = state.darkMode ? 'dark' : 'light';
      drawn = reported;
      if (reported.variant === view.variant && reported.form === view.form && reported.theme === view.theme) return;
      Object.assign(view, reported);
      nameView();
      showDisplay();
      publishView();
    }

    // Before the export has drawn anything, its refusal replaces the diagram.
    // Afterwards it still draws what it last reported, and the toolbar and the
    // address return to that.
    function followRefusal(refusal) {
      hideLoading();
      const accepted = Array.isArray(refusal.accepted) ? refusal.accepted.map(String)
        : refusal.accepted === undefined ? [] : [String(refusal.accepted)];
      const reason = `The diagram does not accept ${refusal.parameter} ${quoted(refusal.value)}.`
        + (accepted.length ? ` It accepts ${alternatives(accepted)}.` : '');
      if (!drawn) {
        showRefusal('The diagram refused to draw this view.', [reason]);
        return;
      }
      console.warn(reason);
      Object.assign(view, drawn);
      showDisplay();
      publishView();
    }

    // The form and the theme set by the page's address, and a reason for each
    // parameter it sets that the viewer does not read or to a value the diagram
    // does not accept.
    function readAddress(model) {
      const query = new URLSearchParams(location.search);
      const named = {};
      const reasons = [];
      const unread = [...new Set(query.keys())].filter(parameter => !VIEWER_PARAMETERS.includes(parameter) && !isTracking(parameter));
      for (const parameter of unread) {
        reasons.push(`The address sets ${parameter} to ${query.getAll(parameter).map(quoted).join(', ')}. This viewer reads only form and theme, and a variant from the path.`);
      }
      for (const [parameter, accepted] of [['form', acceptedForms(model)], ['theme', acceptedThemes(model)]]) {
        const values = query.getAll(parameter);
        if (values.length === 1 && accepted.includes(values[0])) named[parameter] = values[0];
        else if (values.length === 1) {
          reasons.push(`The address sets ${parameter} to ${quoted(values[0])}. This diagram accepts ${alternatives(accepted)}.`);
        } else if (values.length > 1) {
          reasons.push(`The address sets ${parameter} ${values.length} times, to ${values.map(quoted).join(', ')}. It may set it once, to ${alternatives(accepted)}.`);
        }
      }
      return { named, reasons };
    }

    // Replaces the diagram with the reasons its view cannot be drawn.
    function showRefusal(heading, reasons) {
      hideLoading();
      refused = true;
      viewer.classList.add('is-refused');
      frame?.remove();
      frame = null;
      drawn = null;
      if (poster) poster.hidden = true;
      zoomBar.hidden = true;
      const notice = document.createElement('div');
      notice.className = 'viewer-refusal';
      notice.setAttribute('role', 'alert');
      const card = document.createElement('div');
      card.className = 'viewer-refusal-card';
      const title = document.createElement('p');
      title.className = 'viewer-refusal-title';
      title.textContent = heading;
      card.append(title);
      for (const reason of reasons) {
        const line = document.createElement('p');
        line.textContent = reason;
        card.append(line);
      }
      notice.append(card);
      stage.querySelector('.viewer-refusal')?.remove();
      stage.append(notice);
    }

    function clearRefusal() {
      refused = false;
      viewer.classList.remove('is-refused');
      stage.querySelector('.viewer-refusal')?.remove();
    }

    // Selectors and the phone's dropdowns: close on Escape, outside clicks and
    // focus moving into the diagram.
    const dropdowns = [[selector, summary], [variantSelector, variantSummary],
      ...[...menus].map(menu => [menu, menu.querySelector('summary')])];
    for (const [details, detailsSummary] of dropdowns) {
      details.addEventListener('keydown', event => {
        if (event.key === 'Escape') { details.open = false; detailsSummary.focus(); }
      });
      document.addEventListener('click', event => {
        if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
      });
      window.addEventListener('blur', () => { details.open = false; });
    }

    // The variant panel and a dropdown's options open under their summary,
    // moved left where the viewport's right edge would cut them.
    function keepInView(details, panel) {
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        panel.style.left = '0px';
        const bounds = panel.getBoundingClientRect();
        const room = document.documentElement.clientWidth - 16;
        const shift = Math.max(16 - bounds.left, Math.min(0, room - bounds.right));
        panel.style.left = `${shift}px`;
      });
    }
    keepInView(variantSelector, variantPanel);
    for (const menu of menus) {
      const panel = menu.querySelector('.control-menu-options');
      keepInView(menu, panel);
      // A choice is answered by the handlers of its form or quantisation, and closes the dropdown.
      panel.addEventListener('click', event => {
        if (!(event.target instanceof Element) || !event.target.closest('button')) return;
        menu.open = false;
        menu.querySelector('summary').focus();
      });
    }

    // A variant opens in place. Modified clicks still open the variant's page.
    variantPanel.addEventListener('click', event => {
      const option = event.target instanceof Element ? event.target.closest('a[data-variant]') : null;
      if (!option || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      variantSelector.open = false;
      chooseVariant(option.dataset.variant);
      variantSummary.focus();
    });

    // A full-page viewer navigates to the chosen model's page; an inline viewer
    // switches in place. Modified clicks still open the model's page.
    for (const option of options) {
      option.addEventListener('click', event => {
        if (!inline || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        selector.open = false;
        show(option.dataset.slug);
        summary.focus();
      });
    }

    // An inline viewer opens another model on its first variant, in the
    // quantisation on screen, keeping the form and the theme on screen where
    // both models can switch them.
    function show(next) {
      const model = models.get(next);
      if (!model || next === view.slug) return;
      const keeps = current().forms && model.forms;
      view.slug = next;
      view.variant = model.initial_variant ? inQuantisation(model, model.initial_variant) : null;
      if (keeps) nameView();
      else {
        view.form = unnamedForm(model);
        view.theme = unnamedTheme(model);
      }
      viewer.dataset.slug = next;
      viewer.dataset.variant = view.variant ?? '';
      viewer.querySelector('.selector-title-full').textContent = model.title;
      viewer.querySelector('.selector-title-short').textContent = model.name;
      summary.setAttribute('aria-label', `Choose a diagram. Showing ${model.title}`);
      for (const option of options) {
        if (option.dataset.slug === next) option.setAttribute('aria-current', 'true');
        else option.removeAttribute('aria-current');
      }
      const caption = viewer.querySelector('.diagram-caption-text');
      if (caption) caption.textContent = model.description;
      notebook.hidden = !model.notebook_url;
      if (model.notebook_url) notebook.href = model.notebook_url;
      if (poster) {
        poster.querySelector('img').alt = `Preview of the neural circuit diagram of ${model.title}`;
        poster.querySelector('.viewer-prompt-title').textContent = model.title;
        poster.querySelector('.viewer-prompt-detail').textContent = model.detail;
      }
      writeVariantOptions(model);
      showDisplay();
      publishView();
      if (frame || refused) load();
    }

    // Replace the iframe instead of changing its src, so that switching models
    // never adds entries to the page's history.
    function load() {
      const model = current();
      clearRefusal();
      // A new frame shows the export's own loading screen.
      hideLoading();
      const next = document.createElement('iframe');
      next.title = `Interactive neural circuit diagram: ${model.title}`;
      next.setAttribute('sandbox', SANDBOX);
      next.tabIndex = 0;
      // The toolbar replaces the export's own controls, and the address gives
      // the export the view on screen before its first paint.
      const parameters = new URLSearchParams();
      if (model.forms) {
        parameters.set('controls', 'hidden');
        parameters.set('form', view.form);
        parameters.set('darkMode', String(view.theme === 'dark'));
      }
      if (view.variant) parameters.set('variant', view.variant);
      const query = parameters.toString();
      next.src = `${base}${model.slug}/embed/${query ? `?${query}` : ''}`;
      next.addEventListener('load', () => { if (frame === next) send({ type: 'diagram:connect' }); });
      if (frame) frame.replaceWith(next);
      else stage.append(next);
      frame = next;
      drawn = null;
      if (poster) poster.hidden = true;
      scale = 1;
      sliderRequest = null;
      zoomButtons.forEach(button => { button.disabled = true; });
      zoomSlider.disabled = true;
      updateZoom(1, true);
      zoomBar.hidden = isExpanded();
    }

    poster?.querySelector('.load-diagram').addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      load();
      frame.focus();
    });

    // Expand. An inline viewer's is a link to the interactive viewer, which
    // `publishView` points at the view the reader picked. In a full-page viewer
    // it only hides the site navigation (and says so in the address bar); the
    // browser stays as it is, out of full screen.
    if (!inline) {
      toggle.addEventListener('click', () => {
        setExpanded(toggle.getAttribute('aria-expanded') === 'true');
      });
    }

    // Full-page viewer: hide or show the site navigation, keeping the iframe.
    function setExpanded(collapse) {
      const label = collapse ? 'Show navigation' : 'Expand diagram';
      document.body.classList.toggle('is-navigation-hidden', collapse);
      viewer.querySelector('.diagram-navigation').hidden = collapse;
      zoomBar.hidden = collapse || !frame;
      viewer.classList.toggle('is-expanded', collapse);
      publishView();
      toggle.setAttribute('aria-expanded', String(!collapse));
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      toggle.querySelector('span').textContent = label;
      selector.open = false;
      variantSelector.open = false;
      menus.forEach(menu => { menu.open = false; });
    }

    // Some browsers release a captured pointer to this document when it crosses
    // the out-of-process iframe. Forward the release so dragging cannot stick.
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, () => send({ type: 'diagram:pan-end' }));
    }
    window.addEventListener('blur', () => {
      if (!document.hasFocus()) send({ type: 'diagram:pan-end' });
    });

    for (const button of zoomButtons) {
      button.addEventListener('click', () => {
        const requested = button.dataset.zoom === 'reset' ? 1 : scale * (button.dataset.zoom === 'in' ? 1.25 : 0.8);
        send({ type: 'diagram:zoom-center', scale: requested });
      });
    }
    zoomSlider.addEventListener('input', () => {
      sliderRequest = ++nextSliderRequest;
      send({ type: 'diagram:zoom-center', scale: Number(zoomSlider.value) / 100, controlId: sliderRequest });
    });

    function updateZoom(value, moveSlider) {
      scale = Math.max(0.1, Math.min(4, value));
      const percent = `${Math.round(scale * 100)}%`;
      zoomReset.textContent = percent;
      if (moveSlider) {
        zoomSlider.value = String(Math.round(scale * 100));
        zoomSlider.setAttribute('aria-valuetext', percent);
      }
    }

    window.addEventListener('message', event => {
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'tsncd-state') { followExport(data); return; }
      if (data.type === 'tsncd-refused') { followRefusal(data); return; }
      if (data.type === 'diagram:controls-ready') {
        zoomButtons.forEach(button => { button.disabled = false; });
        zoomSlider.disabled = false;
        return;
      }
      if (data.type !== 'diagram:zoom-changed' || !Number.isFinite(data.scale)) return;
      // Older replies must not pull the thumb away from the user's latest input.
      const latest = sliderRequest === null || data.controlId === sliderRequest;
      if (latest) sliderRequest = null;
      updateZoom(data.scale, latest);
    });

    // A full-page viewer opens the view its address names, and an inline
    // viewer the view of an address that names the catalogue's default theme
    // (default_theme in _data/diagrams.yml), or nothing where none is set.
    const opened = current();
    const defaultTheme = acceptedThemes(opened).includes(viewer.dataset.defaultTheme) ? { theme: viewer.dataset.defaultTheme } : {};
    const address = inline ? { named: defaultTheme, reasons: [] } : readAddress(opened);
    named.form = address.named.form !== undefined;
    named.theme = address.named.theme !== undefined;
    view.form = address.named.form ?? unnamedForm(opened);
    view.theme = address.named.theme ?? unnamedTheme(opened);
    writeVariantOptions(opened);
    showDisplay();
    if (address.reasons.length) {
      // The address stays as the reader gave it.
      showRefusal('This address names a view the diagram does not have.', address.reasons);
    } else {
      publishView();
      if (!inline) load();
    }

    setUpShare(share);
  }

  function setUpShare(button) {
    const feedback = button.parentElement.querySelector('.diagram-share-feedback');
    const message = feedback.querySelector('span');
    const field = feedback.querySelector('input');
    let timer;
    button.addEventListener('click', async () => {
      // `publishView` keeps the link on the view on screen.
      const url = button.dataset.shareUrl;
      clearTimeout(timer);
      feedback.hidden = true;
      field.hidden = true;
      button.disabled = true;
      try {
        if (navigator.share) {
          try {
            await navigator.share({ title: button.dataset.shareTitle, url });
            return;
          } catch (error) {
            // Dismissing the native sheet is a normal action, not a copy request.
            if (error instanceof DOMException && error.name === 'AbortError') return;
          }
        }
        try {
          await navigator.clipboard.writeText(url);
          message.textContent = 'Link copied';
          feedback.hidden = false;
          timer = setTimeout(() => { feedback.hidden = true; }, 3000);
        } catch {
          message.textContent = 'Copy diagram link';
          field.value = url;
          field.hidden = false;
          feedback.hidden = false;
          field.focus();
          field.select();
        }
      } finally {
        button.disabled = false;
      }
    });
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Node && !button.parentElement.contains(event.target)) feedback.hidden = true;
    });
    feedback.addEventListener('keydown', event => {
      if (event.key === 'Escape') { feedback.hidden = true; button.focus(); }
    });
  }
})();
