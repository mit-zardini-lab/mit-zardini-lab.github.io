# Builds the interactive diagram pages listed in _data/diagrams.yml.
#
# Each diagram's pyncd export stays byte-for-byte at diagrams/<slug>/figure.html
# in the source. For every diagram this generator writes:
#   /diagrams/<slug>/             full-page viewer (layout: diagram-viewer)
#   /diagrams/<slug>/expanded/    the same viewer, opened with the navigation hidden
#   /diagrams/<slug>/embed/       the export plus _includes/diagram-gestures.js,
#                                 which the viewers load in a sandboxed iframe
#   /diagrams/<slug>/figure.html  a redirect to the viewer, which moves the
#                                 export's `variant`, `form` and `darkMode`
#                                 parameters into the viewer's address and
#                                 drops `controls` and `displayMode`
#   /diagrams/<slug>/embed.html   a redirect to embed/, keeping the query
# and /diagrams/see-diagrams/, which redirects to the default diagram, in the
# default theme where _data/diagrams.yml sets `default_theme`. No
# address needs the .html suffix: GitHub Pages and `jekyll serve` both answer
# /diagrams/<slug>/figure with figure.html.
#
# An export may carry several variants of its model, such as the model decoding
# with and without a cache, each quantised and unquantised. It then holds a
# `tsncd-variants` element, whose format pyncd states in
# obsidian/05-backends/Diagram Wire Format.md, under "A page that carries
# several variants". For an export whose element lists two or more variants the
# generator also writes, for every variant:
#   /diagrams/<slug>/<variant>/            full-page viewer opened on that variant
#   /diagrams/<slug>/<variant>/expanded/   the same viewer with the navigation hidden
# and /diagrams/<slug>/ and /diagrams/<slug>/expanded/ open the export's initial
# variant. A variant the export does not carry has no page, so its address
# returns the site's 404 page. An element listing one variant offers nothing to
# choose, and tsncd refuses a `variant` parameter on such a page, so the
# generator treats it as an export with one figure.
#
# It records on each diagram the address of its notebook on GitHub (see
# link_notebook), whether its export can switch forms, the form and
# the theme it opens in (see detect_forms), and its variants (see
# record_variants), with each quantised variant paired with its unquantised
# form for the viewer's ℝ/FP toggle (see pair_quantisations). The viewer opens an export that can switch forms in the form
# and the theme its address names, all broadcasted and in the reader's system
# theme where the address names neither, whatever the export opens in.
require "fileutils"
require "json"

module Diagrams
  STYLESHEETS = ["/css/diagrams.css"].freeze
  FORMS = %w[arrows-and-boxes arrows-and-broadcasted all-broadcasted].freeze

  # Matches the element whatever the order of its attributes.
  VARIANTS_ELEMENT = %r{<script\b[^>]*\bid="tsncd-variants"[^>]*>(.*?)</script>}m
  # A variant's id is a path segment of its address.
  VARIANT_ID = /\A[a-z0-9]+(?:-[a-z0-9]+)*\z/
  # Addresses under /diagrams/<slug>/ that a variant's page would replace.
  RESERVED_SEGMENTS = %w[embed expanded figure].freeze
  # The quantised and the unquantised variant of one pass (see pair_quantisations).
  QUANTISATION_ID = /\A(.+)-(quantised|unquantised)\z/
  # The passes _includes/diagram-viewer.html has a symbol for: decode, a square
  # filled below its diagonal, and cached, a cylinder.
  PASS_SYMBOLS = %w[decode cached].freeze

  class ViewerPage < Jekyll::PageWithoutAFile
    # `variant` is an entry of diagram["variants"], or nil for an export that
    # carries one figure.
    def initialize(site, diagram, variant, expanded, dir)
      super(site, site.source, dir, "index.html")
      self.content = ""
      self.data = {
        "layout" => "diagram-viewer",
        "title" => "#{Diagrams.view_title(diagram, variant)} · Interactive Diagram",
        "diagram" => diagram,
        "variant" => variant && variant["id"],
        "expanded" => expanded,
        "stylesheets" => STYLESHEETS,
        "sitemap" => !expanded,
      }
    end
  end

  def self.view_title(diagram, variant)
    return diagram["title"] unless variant

    group = diagram["variant_groups"].find { |candidate| candidate["id"] == variant["group"] }
    "#{diagram["title"]} · #{group["title"]}, #{variant["title"]}"
  end

  # Written from the export at build time rather than copied, so figure.html
  # remains the unmodified original.
  class EmbedFile < Jekyll::StaticFile
    NOINDEX = '<meta name="robots" content="noindex">'
    # The export draws its own light and dark themes, so Dark Reader is asked to
    # leave it alone. On a dark system Dark Reader also paints every frame dark
    # the moment it starts loading, until it learns whether it is on for the
    # site. A page remembers the answer in sessionStorage, but this sandboxed
    # frame cannot, so the diagram would flash dark on every load, even with
    # Dark Reader switched off. The script removes that style before the body
    # is parsed, so it is never painted.
    DARK_READER = '<meta name="darkreader-lock"><script>document.querySelectorAll(".darkreader--fallback").forEach(function (style) { style.remove(); });</script>'

    def initialize(site, slug, figure, bridge)
      super(site, site.source, "diagrams/#{slug}/embed", "index.html")
      @figure = figure
      @bridge = bridge
    end

    # Modification times and existence checks follow the export.
    def path
      @figure
    end

    def write(dest)
      target = destination(dest)
      html = File.binread(@figure)
      opening = html.index("<head>")
      html.insert(opening + "<head>".length, DARK_READER) if opening
      head = html.index("</head>")
      html.insert(head, NOINDEX) if head
      html.insert(html.rindex("</body>") || html.length, "<script>#{File.binread(@bridge)}</script>")
      FileUtils.mkdir_p(File.dirname(target))
      File.binwrite(target, html)
      true
    end
  end

  class Generator < Jekyll::Generator
    safe true
    priority :high

    # Moves the `variant` parameter of an export's address into the viewer's
    # path and its `darkMode` parameter into the viewer's `theme`, and drops a
    # valid `controls` or `displayMode`, which the viewer decides. A value the
    # viewer cannot show still reaches the viewer, which refuses it: a variant
    # the export does not carry has no page, darkMode=x becomes theme=x, and
    # any other parameter is refused by name. An empty variant becomes the
    # segment "-", which no variant id can be.
    FIGURE_ADDRESS_TO_VIEWER = <<~JS.gsub(/\s*\n\s*/, " ").strip
      (function (viewer) {
        var query = new URLSearchParams(location.search);
        var variant = query.get('variant');
        var dark = query.get('darkMode');
        query.delete('variant');
        query.delete('darkMode');
        if (['shown', 'hidden'].indexOf(query.get('controls')) >= 0) query.delete('controls');
        if (['slow', 'fast'].indexOf(query.get('displayMode')) >= 0) query.delete('displayMode');
        if (dark !== null) query.set('theme', dark === 'true' ? 'dark' : dark === 'false' ? 'light' : dark);
        var rest = query.toString();
        return viewer + (variant === null ? '' : (encodeURIComponent(variant) || '-') + '/') + (rest ? '?' + rest : '') + location.hash;
      })
    JS

    def generate(site)
      config = site.data["diagrams"]
      return unless config

      bridge = File.join(site.source, "_includes", "diagram-gestures.js")
      config["models"].each do |diagram|
        slug = diagram["slug"]
        figure = File.join(site.source, "diagrams", slug, "figure.html")
        raise "Diagram #{slug}: missing export #{figure}" unless File.file?(figure)

        link_notebook(diagram, config["notebooks"])
        html = File.binread(figure)
        catalogue = read_variant_catalogue(slug, html)
        detect_forms(diagram, html, catalogue)
        record_variants(diagram, catalogue) if catalogue && catalogue["variants"].length >= 2
        add_viewer_pages(site, diagram)
        site.static_files << EmbedFile.new(site, slug, figure, bridge)
        replace_export_with_redirects(site, diagram)
      end

      default = config["default"]
      unless config["models"].any? { |diagram| diagram["slug"] == default }
        raise "_data/diagrams.yml: default '#{default}' is not a listed diagram"
      end
      theme = config["default_theme"]
      if theme && !%w[dark light].include?(theme)
        raise "_data/diagrams.yml: default_theme #{theme.inspect} is neither dark nor light"
      end
      target = "#{site.baseurl}/diagrams/#{default}/"
      site.pages << RedirectPage.new(site, "diagrams/see-diagrams", "index.html", target,
                                     "Interactive Diagrams · Zardini Lab",
                                     theme && "#{DEFAULT_ADDRESS_WITH_THEME}(#{target.to_json}, #{theme.to_json})")
    end

    # The default diagram's address with the default theme, unless the
    # redirect's own address names a theme, keeping the rest of its query.
    DEFAULT_ADDRESS_WITH_THEME = <<~JS.gsub(/\s*\n\s*/, " ").strip
      (function (viewer, theme) {
        var query = new URLSearchParams(location.search);
        if (!query.has('theme')) query.set('theme', theme);
        return viewer + '?' + query.toString() + location.hash;
      })
    JS

    private

    # The address of the Jupyter notebook that writes the diagram's export, on
    # GitHub, for the toolbar's Notebook link: the `notebooks` base of
    # _data/diagrams.yml followed by the diagram's `notebook` path.
    def link_notebook(diagram, base)
      path = diagram["notebook"]
      return unless path

      raise "_data/diagrams.yml: diagram #{diagram["slug"]} names a notebook, and no `notebooks` base is set" unless base
      raise "Diagram #{diagram["slug"]}: notebook #{path.inspect} is not an .ipynb path" unless path.match?(%r{\A[\w./-]+\.ipynb\z})

      diagram["notebook_url"] = "#{base}#{path}"
    end

    # Exports whose renderer accepts `tsncd-display` messages can be redrawn as
    # arrows and boxes, arrows and broadcasted, or all broadcasted, and in either
    # theme. Record that, and the form and theme the export starts in. The
    # viewer draws an export that cannot switch only in these, and the theme is
    # the one thumbnail.jpg was captured in. An export with variants states both
    # in the plain `settings` at the top of its `tsncd-variants` element, and an
    # export with one figure states them in the settings of its message.
    def detect_forms(diagram, html, catalogue)
      diagram["forms"] = html.include?("tsncd-display")
      if catalogue
        settings = catalogue["settings"] || {}
        diagram["form"] = settings["form"] || "all-broadcasted"
        # An export is dark unless it says otherwise.
        diagram["dark"] = settings["darkMode"] != false
      else
        diagram["form"] = html[/"settings": \{[^}]*"form": "([a-z-]+)"/, 1] || "all-broadcasted"
        diagram["dark"] = html[/"settings": \{[^}]*"darkMode": (true|false)/, 1] != "false"
      end
      return if FORMS.include?(diagram["form"])

      raise "Diagram #{diagram["slug"]}: the export opens in form #{diagram["form"].inspect}, " \
            "and the viewer draws #{FORMS.join(", ")}"
    end

    # The parsed `tsncd-variants` element, or nil for an export with no such
    # element. An element holding no variant is read as no element, as tsncd
    # reads it.
    def read_variant_catalogue(slug, html)
      text = html[VARIANTS_ELEMENT, 1]
      return nil unless text

      catalogue = JSON.parse(text.force_encoding(Encoding::UTF_8))
      unless catalogue.is_a?(Hash) && catalogue.fetch("variants", []).is_a?(Array)
        raise "Diagram #{slug}: the tsncd-variants element holds a #{catalogue.class} with no list of variants"
      end
      catalogue.fetch("variants", []).empty? ? nil : catalogue
    end

    # Records the export's groups, its variants and its initial variant on the
    # diagram, for the variant pages and the viewer's variant selector. Each
    # variant keeps its id, group, title and detail.
    def record_variants(diagram, catalogue)
      slug = diagram["slug"]
      groups = catalogue.fetch("groups", []).map { |group| group.slice("id", "title") }
      group_ids = groups.map { |group| group["id"] }
      variants = catalogue["variants"].map { |variant| variant.slice("id", "group", "title", "detail") }
      variants.each do |variant|
        id = variant["id"]
        unless id.is_a?(String) && id.match?(VARIANT_ID)
          raise "Diagram #{slug}: variant id #{id.inspect} is not lowercase letters, digits and single hyphens"
        end
        if RESERVED_SEGMENTS.include?(id)
          raise "Diagram #{slug}: variant id #{id.inspect} is already the address /diagrams/#{slug}/#{id}/"
        end
        unless group_ids.include?(variant["group"])
          raise "Diagram #{slug}: variant #{id} names group #{variant["group"].inspect}, " \
                "and the export lists groups #{group_ids.inspect}"
        end
      end
      ids = variants.map { |variant| variant["id"] }
      repeated = ids.select { |id| ids.count(id) > 1 }.uniq
      raise "Diagram #{slug}: variant ids #{repeated.inspect} appear more than once" unless repeated.empty?
      unless ids.include?(catalogue["initial"])
        raise "Diagram #{slug}: initial variant #{catalogue["initial"].inspect} is not one of #{ids.inspect}"
      end

      occupied = variants.map { |variant| variant["group"] }
      diagram["variant_groups"] = groups.select { |group| occupied.include?(group["id"]) }
      diagram["variants"] = variants
      diagram["initial_variant"] = catalogue["initial"]
      pair_quantisations(diagram)
    end

    # The quantised and the unquantised form of one pass, `<pass>-quantised`
    # and `<pass>-unquantised` in one group, are one choice of the variant
    # selector, and the toolbar's ℝ/FP toggle switches between them. Each
    # variant of a pair records its `quantisation` and its `counterpart`. A
    # group holding exactly one pair is `paired`: the selector lists it as one
    # choice named by the group's title. The diagram records `quantisation`
    # when it holds any pair, so the toolbar shows the toggle.
    def pair_quantisations(diagram)
      variants = diagram["variants"]
      variants.each do |variant|
        match = variant["id"].match(QUANTISATION_ID)
        next unless match

        other = match[2] == "quantised" ? "unquantised" : "quantised"
        counterpart = variants.find do |candidate|
          candidate["id"] == "#{match[1]}-#{other}" && candidate["group"] == variant["group"]
        end
        next unless counterpart

        variant["quantisation"] = match[2]
        variant["counterpart"] = counterpart["id"]
      end
      diagram["variant_groups"].each do |group|
        members = variants.select { |variant| variant["group"] == group["id"] }
        group["paired"] = members.length == 2 && members.all? { |variant| variant["counterpart"] }
      end
      diagram["quantisation"] = variants.any? { |variant| variant["counterpart"] }
      # The toolbar draws the passes as symbols, in place of the variant
      # selector, where every pass is a group it has a symbol for and is one
      # choice: a pair, or a single variant, as MiMo-V2.6-Pro's passes in the
      # reals are until a quantised form joins them.
      groups = diagram["variant_groups"]
      diagram["pass_symbols"] = groups.length >= 2 && groups.all? do |group|
        members = variants.count { |variant| variant["group"] == group["id"] }
        PASS_SYMBOLS.include?(group["id"]) && (group["paired"] || members == 1)
      end
    end

    def add_viewer_pages(site, diagram)
      root = "diagrams/#{diagram["slug"]}"
      variants = diagram["variants"] || []
      initial = variants.find { |variant| variant["id"] == diagram["initial_variant"] }
      site.pages << ViewerPage.new(site, diagram, initial, false, root)
      site.pages << ViewerPage.new(site, diagram, initial, true, "#{root}/expanded")
      variants.each do |variant|
        site.pages << ViewerPage.new(site, diagram, variant, false, "#{root}/#{variant["id"]}")
        site.pages << ViewerPage.new(site, diagram, variant, true, "#{root}/#{variant["id"]}/expanded")
      end
    end

    # The export is served only from embed/, inside the viewer. Its own file
    # name, figure.html, becomes a redirect into the viewer, and embed.html a
    # redirect to embed/.
    def replace_export_with_redirects(site, diagram)
      slug = diagram["slug"]
      export_url = "/diagrams/#{slug}/figure.html"
      site.static_files.reject! { |file| file.url.sub(%r{\A/*}, "/") == export_url }
      viewer = "#{site.baseurl}/diagrams/#{slug}/"
      title = "#{diagram["title"]} · Zardini Lab"
      site.pages << RedirectPage.new(site, "diagrams/#{slug}", "figure.html", viewer, title,
                                     "#{FIGURE_ADDRESS_TO_VIEWER}(#{viewer.to_json})")
      site.pages << RedirectPage.new(site, "diagrams/#{slug}", "embed.html",
                                     "#{site.baseurl}/diagrams/#{slug}/embed/", title)
    end
  end

  # A relative redirect (jekyll-redirect-from would prefix site.url, which is
  # not the custom domain). `destination` is a JavaScript expression for the
  # address to open. By default it is the target followed by the query string
  # and the fragment of the requested address.
  class RedirectPage < Jekyll::PageWithoutAFile
    def initialize(site, dir, name, target, title, destination = nil)
      super(site, site.source, dir, name)
      canonical = "#{site.config["canonical_url"]}#{target}"
      destination ||= "#{target.to_json} + location.search + location.hash"
      self.data = { "sitemap" => false }
      self.content = <<~HTML
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <title>#{title}</title>
        <link rel="canonical" href="#{canonical}">
        <meta name="robots" content="noindex">
        <meta http-equiv="refresh" content="0; url=#{target}">
        <script>location.replace(#{destination});</script>
        <p><a href="#{target}">Continue to the interactive diagrams</a></p>
        </html>
      HTML
    end
  end
end
