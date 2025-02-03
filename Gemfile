source "https://rubygems.org"

# Specify Ruby version explicitly for better compatibility
ruby "3.1.4"

# Core Jekyll version (latest stable)
gem "jekyll", "4.3.2"

# Theme for Jekyll (Minima)
gem "minima", "2.5.1"

# Essential plugins
gem "jekyll-feed"  # Atom feeds
gem "jekyll-sitemap"  # Auto-generate sitemap.xml for SEO
gem "jekyll-redirect-from"  # Redirect support
gem "jekyll-seo-tag"  # SEO meta tags
gem "jekyll-paginate"  # Pagination support
gem "jekyll-scholar"  # Manage citations/bibliographies

# For GitHub Pages (Uncomment if deploying to GitHub Pages)
gem "github-pages", group: :jekyll_plugins

# Needed for Ruby 3.x (Webrick was removed from the standard library)
gem "webrick"

# Testing tools
group :jekyll_plugins do
  gem "html-proofer"  # Checks broken links and HTML validity
end
