/**
 * Invented web pages for the extraction and clip tests.
 *
 * Every word here is made up (Acme, example.com) and nothing comes from a real page or a
 * real note; see "Real notes stay out of the repo" in AGENTS.md. What they keep is the
 * shape that matters to Readability: enough paragraph text to score as an article, and
 * the chrome around it (navigation, a sidebar, a footer, a newsletter form) that a clip
 * must leave behind.
 */

/** Three paragraphs of body text, long enough between them to pass Readability's checks. */
export const PARAGRAPHS = [
  'An anvil that is looked after will outlast the smith who bought it. The face is hardened steel, and the first thing to know is that it is meant to be struck by hot metal and a hammer, never by a cold chisel or a stray blow that misses the work and lands on the edge.',
  'Before each session, brush the face clean of scale and check the edges for chips. A small chip can be dressed with a file, slowly and with the grain, but a crack that runs into the face is a reason to stop and ask someone who repairs them for a living rather than carry on.',
  'At the end of the day, wipe the face with a thin film of oil so that the morning damp does not leave rust where the work will sit tomorrow. Keep the stand level and the anvil fixed to it, because a ringing anvil that shifts under the hammer is tiring to work on and unsafe besides.',
];

const CHROME_HEAD = `
  <header class="site-header">
    <a href="/" class="logo">Acme Workshop</a>
    <nav><ul>
      <li><a href="/shop">Shop the catalogue</a></li>
      <li><a href="/guides">All guides</a></li>
      <li><a href="/about">About the workshop</a></li>
    </ul></nav>
  </header>`;

const CHROME_SIDE = `
  <aside class="sidebar">
    <h3>Popular this week</h3>
    <ul>
      <li><a href="/guides/tongs">Choosing your first tongs</a></li>
      <li><a href="/guides/coal">Coal or gas for the forge</a></li>
    </ul>
    <form action="/subscribe"><input name="email"><button>Subscribe to the newsletter</button></form>
  </aside>`;

const CHROME_FOOT = `
  <footer class="site-footer">
    <p>Copyright Acme Workshop. Terms of sale and the privacy notice.</p>
  </footer>`;

/** A guide with a title, a byline, site metadata and all the chrome around it. */
export const ARTICLE_PAGE = `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <title>Caring for your anvil | Acme Workshop</title>
  <meta property="og:site_name" content="Acme Workshop">
  <meta name="description" content="How to keep an anvil's face true for decades.">
  <script>window.analytics = { track() {} };</script>
  <style>.sidebar { float: right }</style>
</head>
<body>
  ${CHROME_HEAD}
  <main>
    <article>
      <h1>Caring for your anvil</h1>
      <p class="byline">By Pat Example</p>
      <p>${PARAGRAPHS[0]}</p>
      <p>${PARAGRAPHS[1]} See <a href="/guides/dressing-edges">dressing the edges</a> for the method.</p>
      <p>${PARAGRAPHS[2]}</p>
    </article>
  </main>
  ${CHROME_SIDE}
  ${CHROME_FOOT}
</body>
</html>`;

/** A guide whose links and pictures are written relative to the page, as most sites write them. */
export const RELATIVE_PAGE = `<!doctype html>
<html>
<head><title>Forge welding, step by step</title></head>
<body>
  ${CHROME_HEAD}
  <article>
    <h1>Forge welding, step by step</h1>
    <p>${PARAGRAPHS[0]}</p>
    <figure><img src="images/scarf-joint.jpg" alt="A scarf joint ready to weld"></figure>
    <p>${PARAGRAPHS[1]} The <a href="../flux.html">notes on flux</a> say which to use.</p>
    <p><img src="/media/heat-colours.png" alt="Heat colours chart"></p>
    <p>${PARAGRAPHS[2]}</p>
  </article>
  ${CHROME_FOOT}
</body>
</html>`;

/** A front page: headlines and links, nothing anyone would call an article. */
export const LINKS_PAGE = `<!doctype html>
<html lang="en">
<head><title>Acme Workshop</title></head>
<body>
  ${CHROME_HEAD}
  <h2>Latest guides</h2>
  <ul>
    <li><a href="/guides/anvil">Caring for your anvil</a></li>
    <li><a href="/guides/welding">Forge welding</a></li>
    <li><a href="/guides/tongs">Choosing tongs</a></li>
  </ul>
  <p>Open Tuesday to Saturday.</p>
  ${CHROME_FOOT}
</body>
</html>`;
