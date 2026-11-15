import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublishedPage, listNavigation } from "@live-competition-engine/db/cms";
import styles from "./cms-page.module.css";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { organizationId, slug } = await params;
  const page = await getPublishedPage(organizationId, slug);
  return { title: page?.title ?? "Page not found" };
}

/**
 * Public CMS page. `page.html` comes only from the restricted Markdown renderer
 * (packages/domain/src/markdown.ts), which escapes all source text and allows only
 * http(s)/mailto/relative links, so it is safe to inject.
 */
export default async function PublicCmsPage({ params }: Params) {
  const { organizationId, slug } = await params;
  const page = await getPublishedPage(organizationId, slug);
  if (!page) notFound();
  const navigation = await listNavigation(organizationId, { publicOnly: true });
  return (
    <div className={styles.page}>
      {navigation.length > 0 && (
        <nav aria-label="Site">
          <ul className={styles.nav}>
            {navigation.map(entry => (
              <li key={`${entry.href}:${entry.label}`}>
                <a href={entry.href} aria-current={entry.pageId === page.pageId ? "page" : undefined}>{entry.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <main>
        <article>
          <h1>{page.title}</h1>
          <div className={styles.body} dangerouslySetInnerHTML={{ __html: page.html }} />
          <p className={styles.meta}>Version {page.version}, published <time dateTime={page.publishedAt.toISOString()}>{page.publishedAt.toISOString().slice(0, 10)}</time></p>
        </article>
      </main>
    </div>
  );
}
