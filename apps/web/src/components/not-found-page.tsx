/** The 404 page for public routes (the CMS catch-all and the blog). */
export function NotFoundPage() {
  return (
    <main className="page-wrap px-4 py-24 text-center">
      <h1 className="display-title text-3xl">Page not found</h1>
      <p className="mt-4 text-muted-foreground">
        There is nothing at this address. It may have moved or been taken down.{" "}
        <a href="/">Go to the home page</a>.
      </p>
    </main>
  );
}
