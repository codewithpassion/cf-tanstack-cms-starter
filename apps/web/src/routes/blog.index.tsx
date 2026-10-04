// biome-ignore-all lint/security/noDangerouslySetInnerHtml: JSON-LD is serialised with safeJsonLd, which escapes `<`, `>` and `&`.
/**
 * The blog index: published CMS posts from KV `posts:index`, newest first, filtered on the client
 * by `?category=` and `?tag=`. With no `posts:index` yet (nothing ever published) it lists nothing
 * and shows the empty state.
 */

import { safeJsonLd } from "@repo/cms-core/json-ld";
import {
  filterPosts,
  formatPostDate,
  type PostFilter,
  postCategories,
} from "@repo/cms-core/posts";
import { defaultShareImage } from "@repo/cms-core/seo/build-head";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { blogIndexRobots } from "@repo/cms-core/sitemap";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useMemo } from "react";

import { Footer } from "#/components/footer";
import { Navigation } from "#/components/navigation";
import { getTrpc } from "#/integrations/trpc/client";
import {
  siteConfigFromMatches,
  siteSeoFromMatches,
  useSiteConfig,
} from "#/modules/cms/site/site-context";
import { SiteHref, useSite } from "#/modules/cms/site/use-site";

const titleOf = (config: SiteConfig) => `Blog | ${config.name}`;
const descriptionOf = (config: SiteConfig) => `Articles from ${config.name}.`;
const blogUrl = (config: SiteConfig) => `${config.origin}/blog`;

export const Route = createFileRoute("/blog/")({
  validateSearch: (search: Record<string, unknown>): PostFilter => {
    const category = filterParam(search.category);
    const tag = filterParam(search.tag);
    return { ...(category && { category }), ...(tag && { tag }) };
  },
  head: ({ loaderData, matches }) => {
    const config = siteConfigFromMatches(matches);
    const site = siteSeoFromMatches(matches);
    const image = defaultShareImage(config, site).url;
    const title = titleOf(config);
    const description = descriptionOf(config);
    const url = blogUrl(config);
    return {
      meta: [
        { title },
        { name: "description", content: description },
        {
          name: "robots",
          content: blogIndexRobots(loaderData?.posts.length ?? 0),
        },
        { property: "og:type", content: "website" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { property: "og:image", content: image },
        { name: "twitter:card", content: site.twitterCard },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "twitter:image", content: image },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  loader: () => getTrpc().cms.public.getBlogIndexData.query(),
  component: BlogIndex,
});

/** Longest `?category=` / `?tag=` kept: the longest category a post can have (post-panel.tsx). */
const MAX_FILTER_LENGTH = 100;

/** A non-empty string filter value, cut to MAX_FILTER_LENGTH; anything else is no filter. */
function filterParam(value: unknown): string | undefined {
  return typeof value === "string" && value
    ? value.slice(0, MAX_FILTER_LENGTH)
    : undefined;
}

/** The Blog and BreadcrumbList JSON-LD nodes for the index. */
function blogJsonLd(config: SiteConfig) {
  const url = blogUrl(config);
  return [
    {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: `${config.name} Blog`,
      description: descriptionOf(config),
      url,
      publisher: {
        "@type": "Organization",
        name: config.name,
        url: config.origin,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: config.origin },
        { "@type": "ListItem", position: 2, name: "Blog", item: url },
      ],
    },
  ];
}

function BlogIndex() {
  const loaderData = Route.useLoaderData();
  const filter = Route.useSearch();
  const config = useSiteConfig();
  const { nav } = useSite();
  const jsonLd = useMemo(() => blogJsonLd(config), [config]);
  const categories = useMemo(
    () => postCategories(loaderData.posts),
    [loaderData.posts]
  );
  const posts = useMemo(
    () => filterPosts(loaderData.posts, filter),
    [loaderData.posts, filter]
  );
  const filtered = Boolean(filter.category || filter.tag);

  return (
    <div className="overflow-x-clip bg-background font-sans text-foreground">
      {jsonLd.map((node) => (
        <script
          dangerouslySetInnerHTML={{ __html: safeJsonLd(node) }}
          key={node["@type"]}
          type="application/ld+json"
        />
      ))}
      <div className="pointer-events-none fixed inset-0 z-0 bg-gradient-to-tr from-primary/10 via-transparent to-transparent" />

      <Navigation />

      {/* Hero */}
      <section className="relative flex min-h-[40vh] items-center justify-center pt-24 pb-12">
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <motion.div
            animate={{ y: 0, opacity: 1 }}
            className="text-center"
            initial={{ y: -50, opacity: 0 }}
            transition={{ duration: 0.8 }}
          >
            <h1 className="mb-6 font-heading text-4xl text-foreground md:text-6xl lg:text-7xl">
              Blog
            </h1>
            <div className="mx-auto mb-8 h-1 w-24 bg-gradient-to-r from-primary to-primary-soft" />
            <p className="mx-auto max-w-3xl font-sans text-lg text-muted-foreground leading-relaxed md:text-xl">
              {descriptionOf(config)}
            </p>
          </motion.div>
        </div>
      </section>

      {/* Blog Post Grid */}
      <section className="relative py-16">
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {(categories.length > 1 || filtered) && (
            <nav
              aria-label="Filter articles"
              className="mb-12 flex flex-wrap justify-center gap-3"
            >
              <Link className={filterChip(!filtered)} to="/blog">
                All
              </Link>
              {categories.map((category) => (
                <Link
                  className={filterChip(
                    filter.category?.toLowerCase() === category.toLowerCase()
                  )}
                  key={category}
                  search={{ category }}
                  to="/blog"
                >
                  {category}
                </Link>
              ))}
              {!!filter.tag && (
                <Link
                  className={filterChip(true)}
                  search={filter.category ? { category: filter.category } : {}}
                  to="/blog"
                >
                  #{filter.tag} &times;
                </Link>
              )}
            </nav>
          )}
          {posts.length === 0 && (
            <p
              className="py-12 text-center font-sans text-lg text-muted-foreground"
              data-testid="blog-empty"
            >
              {filtered
                ? "No articles match this filter."
                : "No articles yet. Check back soon."}
            </p>
          )}
          <div className="grid gap-8 md:grid-cols-2">
            {posts.map((post, index) => (
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                key={post.slug}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
                whileInView={{ y: 0, opacity: 1 }}
              >
                <Link
                  className="group block h-full rounded-lg border border-border bg-card p-8 transition-colors hover:border-primary"
                  params={{ slug: post.slug }}
                  to="/blog/$slug"
                >
                  <div className="mb-4 flex items-center gap-3">
                    <span className="border border-primary/30 px-2 py-1 font-sans text-primary text-xs uppercase tracking-wider">
                      {post.category}
                    </span>
                    <span className="font-sans text-muted-foreground text-xs">
                      {post.readingTime}
                    </span>
                  </div>
                  <h2 className="mb-3 font-heading text-foreground text-xl leading-tight transition-colors group-hover:text-primary">
                    {post.title}
                  </h2>
                  <p className="mb-6 text-muted-foreground leading-relaxed">
                    {post.description}
                  </p>
                  <div className="mt-auto flex items-center justify-between">
                    <div className="flex items-center gap-2 font-sans text-muted-foreground text-sm">
                      <span>{post.author}</span>
                      <span>·</span>
                      <span>{formatPostDate(post.datePublished)}</span>
                    </div>
                    <span className="font-sans text-primary text-xs uppercase tracking-wider transition-transform group-hover:translate-x-1">
                      Read article &rarr;
                    </span>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA: the site doc's nav button */}
      <section className="relative py-20">
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <motion.div
            className="mx-auto max-w-4xl rounded-lg border border-border bg-card p-12 text-center"
            initial={{ y: 50, opacity: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            whileInView={{ y: 0, opacity: 1 }}
          >
            <h2 className="mb-6 font-heading text-3xl text-foreground md:text-4xl">
              Have a question not covered here?
            </h2>
            <SiteHref
              className="inline-block rounded-md bg-primary px-8 py-4 font-sans font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              href={nav.cta.href}
            >
              {nav.cta.label}
            </SiteHref>
          </motion.div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

/** A category filter link, highlighted when it's the active one. */
function filterChip(active: boolean): string {
  return `font-sans text-xs uppercase tracking-wider border px-3 py-1 transition-colors ${
    active
      ? "text-primary border-primary"
      : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
  }`;
}
