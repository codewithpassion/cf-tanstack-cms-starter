/** The 404 page for public routes (the CMS catch-all and the blog). */
export function NotFoundPage() {
  return (
    <main className="page-wrap px-4 py-24 text-center">
      <p className="island-kicker mb-3">404</p>
      <h1 className="display-title text-3xl sm:text-4xl">Page not found</h1>
      <p className="mx-auto mt-3 max-w-md text-muted-foreground">
        There is nothing at this address. It may have moved or been taken down.
      </p>
      <a
        className="mt-8 inline-block rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground text-sm shadow-soft transition-colors hover:bg-primary/90"
        href="/"
      >
        Go to the home page
      </a>
    </main>
  );
}
