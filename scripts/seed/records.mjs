/**
 * The notes that fill the notebooks with fields, and the awkward cases.
 *
 * Everything here is invented. Businesses are generic or the conventional placeholders
 * (Acme, Contoso, Northwind); people are first names over common surnames; addresses and
 * sites are `example.com`, `.org` and `.net`; phone numbers are in 555-0100 to 555-0199,
 * the block reserved for fiction. None of it is copied from an account, and nothing that
 * is should be added: this file is public.
 *
 * Dates are relative. `age` is how many days ago a note was made, and `day(n)` is a date
 * field `n` days from the day the seed runs — negative for the past — so a coupon that
 * expired last month has always expired last month, whenever the seed is loaded. The
 * loader turns both into absolute values.
 *
 * A note's shape: `key` (stable, what makes a re-run find it), `title`, `body`, `tags`,
 * `notebook`, `fields` by name, `age`, and optionally `files` and `trashed`. Files are
 * drawn by `files.mjs` from the same lines that become their stored text.
 */

/** A date field `n` days from the day the seed is loaded. */
export const day = (n) => ({ day: n });

const RESTAURANTS = [
  // [restaurant, dish, rating, again, review, tags, age]
  ['The Copper Kettle', 'Chicken pot pie', 4, 'Yes', 'Flaky top, gravy not too salty. Huge portion.', ['comfort-food'], 12],
  ['Blue Fern Noodle Bar', 'Spicy dan dan noodles', 5, 'Yes', 'Best noodles in town, ask for extra chili oil.', ['noodles', 'spicy'], 19],
  ['Juniper & Salt', 'Halibut special', 3, 'Maybe', 'Fish was perfect, sides were an afterthought.', ['date-night'], 26],
  ['Lantern Street Tacos', 'Al pastor tacos', 5, 'Yes', 'Pineapple on the spit. Cash only.', ['tacos', 'cheap-eats'], 33],
  ['Harbor Light Oyster Co.', 'Half dozen, chef picks', 4, 'Yes', 'Mignonette was the star.', ['seafood'], 41],
  ['Saffron Table', 'Lamb biryani', 4, 'Yes', 'Fragrant, generous, slow service on a Friday.', ['takeout'], 48],
  ['Northside Pizza Works', 'Margherita', 3, 'Maybe', 'Good crust, underseasoned sauce.', ['pizza'], 55],
  ['Little Fig Bakery', 'Cardamom bun', 5, 'Yes', 'Go before ten or they are gone.', ['breakfast', 'bakery'], 62],
  ['Ember & Oak', 'Smoked brisket plate', 4, 'Yes', 'Bark was excellent, beans forgettable.', ['bbq'], 70],
  ['Moss Creek Diner', 'Hash and eggs', 2, 'No', 'Cold plate, long wait. Coffee was fine.', ['breakfast'], 77],
  ['Golden Wok Express', 'General chicken', 3, 'Maybe', 'Exactly what you expect, which is the point.', ['takeout'], 85],
  ['Pine & Pepper', 'Mushroom risotto', 4, 'Yes', 'Rich without being heavy.', ['vegetarian', 'date-night'], 94],
  ['Riverbend Ramen', 'Tonkotsu ramen', 5, 'Yes', 'Broth like velvet. Egg cooked exactly right.', ['noodles'], 103],
  ['The Quiet Fork', 'Tasting menu', 3, 'No', 'Beautiful plates, left hungry, very expensive.', ['date-night'], 118],
  ['Sunrise Pho House', 'Rare beef pho', 4, 'Yes', 'Clean broth, huge basil plate.', ['noodles', 'cheap-eats'], 131],
  ['Old Mill Brewpub', 'Fish and chips', 3, 'Maybe', 'Batter crisp, chips soggy.', ['pub'], 146],
  ['Casa Verde', 'Chile relleno', 4, 'Yes', 'Roasted properly, not drowned in sauce.', ['spicy'], 160],
  ['Fennel & Fig', 'Grain bowl', 3, 'Maybe', 'Healthy, fine, not exciting.', ['lunch', 'vegetarian'], 175],
  ['Smokestack Burgers', 'Double smash burger', 5, 'Yes', 'Crispy edges, soft bun, perfect.', ['burgers', 'cheap-eats'], 190],
  ['Tidewater Kitchen', 'Shrimp and grits', 4, 'Yes', 'Grits creamy, shrimp a bit overcooked.', ['seafood'], 214],
  ['Kettle & Crumb', 'Tomato soup and grilled cheese', 4, 'Yes', 'Exactly right on a cold day.', ['lunch', 'comfort-food'], 240],
  ['Basil Street Thai', 'Pad see ew', 2, 'No', 'Sweet and gluey. Will try somewhere else.', ['noodles', 'takeout'], 266],
];

const WATCH = [
  // [title, type, status, priority, where, recommended by, rating or null, age, runtime in minutes]
  ['The Long Harbor', 'Movie', 'Watched', 'Must Watch', 'Streaming', 'A friend', 4.5, 9, 128],
  ['Glass Orchard', 'TV Series', 'Watching', 'Must Watch', 'Streaming', 'Newsletter', null, 16, 1140],
  ['Signal Hill', 'Movie', 'Want to Watch', 'Want To', 'Rental', 'Podcast', null, 23, 104],
  ['Paper Moons', 'Documentary', 'Watched', 'Want To', 'Library', 'Book club', 3.5, 30, 92],
  ['The Quiet Engine', 'Docuseries', 'Want to Watch', 'Must Watch', 'Streaming', 'Coworker', null, 37, 360],
  ['Northern Static', 'TV Series', 'Gave Up', 'Someday', 'Streaming', '', 2, 44, 2310],
  ['A Field Guide to Leaving', 'Movie', 'Want to Watch', 'Someday', 'Theater', 'Review site', null, 51, 117],
  ['Salt Roads', 'Documentary', 'Want to Watch', 'Maybe', 'Free online', '', null, 58, 86],
  ['Overtime at the Observatory', 'Comedy Special', 'Watched', 'Want To', 'Streaming', 'A friend', 4, 65, 64],
  ['How Bridges Hold', 'Talk / Short', 'Watched', 'Must Watch', 'Free online', 'Newsletter', 5, 72, 18],
  ['The Lighthouse Accounts', 'TV Series', 'Rewatch', 'Must Watch', 'Streaming', '', 5, 80, 1860],
  ['Copperline', 'Movie', 'Want to Watch', 'Want To', 'Rental', 'Coworker', null, 88, 133],
  ['Weather for Beginners', 'Docuseries', 'Watching', 'Want To', 'Broadcast', '', null, 96, 285],
  ['Small Hours', 'Movie', 'Watched', 'Maybe', 'Library', 'Podcast', 3, 104, 99],
  ['The Cartographer\'s Daughter', 'Movie', 'Want to Watch', 'Must Watch', 'Theater', 'A friend', null, 112, 141],
  ['Kitchen Table Physics', 'Talk / Short', 'Want to Watch', 'Someday', 'Free online', '', null, 120, 22],
  ['Red Clay Country', 'Documentary', 'Watched', 'Want To', 'Streaming', 'Book club', 4, 128, 95],
  ['Second Shift', 'TV Series', 'Want to Watch', 'Maybe', 'Streaming', 'Review site', null, 136, 1520],
  ['Ninety Miles of Fence', 'Docuseries', 'Gave Up', 'Someday', 'Streaming', '', 1.5, 144, 410],
  ['Paperweight', 'Comedy Special', 'Want to Watch', 'Want To', 'Streaming', 'Coworker', null, 152, 71],
  ['The Last Ferry Out', 'Movie', 'Watched', 'Must Watch', 'Rental', 'A friend', 4.5, 160, 112],
  ['Under the Viaduct', 'Movie', 'Want to Watch', 'Someday', 'Library', '', null, 168, 108],
  ['Field Notes from the Arctic', 'Documentary', 'Want to Watch', 'Must Watch', 'Free online', 'Newsletter', null, 176, 88],
  ['Monday People', 'TV Series', 'Watched', 'Want To', 'Broadcast', '', 3.5, 184, 1995],
];

const COUPONS = [
  // [vendor, code, discount, added (days ago), expires (days from now, or null), used, notes]
  ['Acme Outfitters', 'SAVE15-EXAMPLE', '15% off', 6, 24, false, 'Excludes sale items.'],
  ['Northwind Coffee', 'FREESHIP-SAMPLE', 'Free shipping', 13, 60, false, 'Orders over $30.'],
  ['Contoso Books', 'READMORE-0000', '$5 off $25', 20, -10, false, 'Expired before I used it.'],
  ['Fabrikam Hardware', 'SPRING-DEMO-20', '20% off one item', 27, 3, false, 'Good for the drill.'],
  ['Acme Outfitters', 'WELCOME-PLACEHOLDER', '10% off first order', 90, null, true, 'Used on the rain shell.'],
  ['Tailspin Bikes', 'TUNEUP-EXAMPLE', '$20 off a tune-up', 34, 120, false, 'Book two weeks ahead.'],
  ['Wide World Travel', 'TRIP-SAMPLE-50', '$50 off a booking', 48, -45, true, ''],
  ['Northwind Coffee', 'BEANS2-EXAMPLE', 'Buy one bag, get one half off', 55, 14, false, 'In store only.'],
  ['Litware Software', 'ANNUAL-DEMO', '30% off annual plan', 62, -2, false, 'Missed it by two days.'],
  ['Fabrikam Hardware', 'PRO-PLACEHOLDER', '$10 off $50', 75, 200, false, ''],
  ['Contoso Pharmacy', 'PHOTO-SAMPLE', '40% off prints', 81, 30, true, 'Printed the calendar photos.'],
  ['Adventure Works', 'GEAR-EXAMPLE-25', '25% off one item', 99, null, false, 'No expiration printed.'],
];

const CONTACTS = [
  // [name, company, role, email, phone, website, categories, met (days ago)]
  ['Casey Mason', 'Mason & Daughters Plumbing', 'Owner', 'casey@example.com', '555-0101', 'https://plumbing.example.com', ['Home', 'Trades'], 40],
  ['Jordan Baker', 'Northwind Coffee', 'Roaster', 'jordan@northwind.example.com', '555-0102', 'https://northwind.example.com', ['Food & Drink'], 52],
  ['Riley Carter', 'Contoso Auto Repair', 'Service advisor', 'service@contoso-auto.example.com', '555-0103', 'https://auto.example.org', ['Auto'], 67],
  ['Morgan Fisher', 'Tailspin Bikes', 'Mechanic', 'morgan@tailspin.example.net', '555-0104', '', ['Outdoors'], 85],
  ['Avery Cooper', 'Fabrikam Electric', 'Electrician', 'avery@fabrikam.example.com', '555-0105', 'https://electric.example.com', ['Home', 'Trades'], 101],
  ['Quinn Taylor', 'Litware Consulting', 'IT consultant', 'quinn@litware.example.com', '555-0106', 'https://litware.example.com', ['Tech'], 118],
  ['Drew Walker', 'Woodgrove Financial', 'Advisor', 'drew.walker@woodgrove.example.com', '555-0107', 'https://woodgrove.example.com', ['Finance'], 133],
  ['Sam Gardner', 'Greenleaf Landscaping', 'Crew lead', 'sam@greenleaf.example.org', '555-0108', '', ['Home', 'Outdoors'], 150],
  ['Jamie Hunter', 'Trailhead Outfitters', 'Guide', 'jamie@trailhead.example.net', '555-0109', 'https://trailhead.example.net', ['Outdoors'], 171],
  ['Taylor Brooks', 'Adventure Works', 'Store manager', 'taylor@adventure-works.example.com', '555-0110', 'https://adventure-works.example.com', ['Outdoors', 'Food & Drink'], 190],
  ['Robin Fletcher', 'Contoso Dental', 'Front desk', 'frontdesk@contoso-dental.example.com', '555-0111', 'https://dental.example.com', ['Health'], 215],
  ['Alex Turner', 'Proseware Roofing', 'Estimator', 'alex@proseware.example.com', '555-0112', '', ['Home', 'Trades'], 240],
  // The one that has broken a layout before: an address far wider than any column.
  [
    'Pat Underwood',
    'The Extraordinarily Long-Named Regional Property Management & Maintenance Cooperative',
    'Maintenance coordinator for the north and east buildings',
    'maintenance.requests.north.and.east.buildings@regional-property-cooperative.example.com',
    '555-0113',
    'https://www.regional-property-cooperative.example.com/residents/maintenance/requests',
    ['Home', 'Trades', 'Finance', 'Tech'],
    260,
  ],
];

/** Receipts carry files. `lines` is the file's text: what a PDF draws and what is stored. */
const RECEIPTS = [
  {
    vendor: 'Fabrikam Hardware',
    amount: 48.17,
    age: 8,
    category: 'Hardware',
    reimbursed: false,
    files: [
      {
        name: 'fabrikam-receipt.pdf',
        lines: [
          'Fabrikam Hardware',
          'Store 0042  123 Example Ave',
          '',
          'Wood screws 2in box        8.99',
          'Wood glue 16oz            11.49',
          'Sandpaper assortment      14.99',
          'Shelf brackets x4          9.98',
          '',
          'Subtotal                  45.45',
          'Tax                        2.72',
          'Total                     48.17',
          'Paid by card ending 0000',
        ],
      },
    ],
  },
  {
    vendor: 'Northwind Grocers',
    amount: 86.4,
    age: 15,
    category: 'Groceries',
    reimbursed: false,
    files: [
      {
        name: 'grocery receipt.png',
        image: true,
        lines: [
          'NORTHWIND GROCERS',
          'Sourdough loaf 6.50',
          'Olive oil 12.99',
          'Coffee beans 15.00',
          'Produce 22.31',
          'Dairy 14.60',
          'Pantry 15.00',
          'TOTAL 86.40',
        ],
      },
    ],
  },
  {
    vendor: 'Contoso Auto Repair',
    amount: 412.0,
    age: 29,
    category: 'Auto',
    reimbursed: false,
    // Three pages, so a multi-page PDF's page count and its expansion have one to show.
    files: [
      {
        name: 'contoso-auto-invoice.pdf',
        pages: [
          [
            'Contoso Auto Repair - Invoice 2026-0117',
            'Vehicle: 2018 sedan, 84,210 miles',
            '',
            'Front brake pads and rotors   289.00',
            'Brake fluid flush              79.00',
            'Multi-point inspection          0.00',
          ],
          [
            'Inspection notes',
            'Rear pads at 5mm, recheck in 6 months.',
            'Cabin air filter dirty, replace next visit.',
            'Tires at 6/32, rotate at next oil change.',
          ],
          ['Warranty', 'Parts and labor warranted 12 months or 12,000 miles.', 'Total due 412.00  Paid in full'],
        ],
      },
    ],
  },
  {
    vendor: 'Litware Office Supply',
    amount: 23.75,
    age: 44,
    category: 'Office',
    reimbursed: true,
    files: [
      {
        name: 'litware-order-55821.pdf',
        lines: ['Litware Office Supply', 'Order 55821', '', 'Printer paper 2 reams  15.98', 'Gel pens 12 pack        7.77', 'Total                  23.75'],
      },
    ],
  },
  {
    vendor: 'Blue Fern Noodle Bar',
    amount: 37.2,
    age: 19,
    category: 'Dining',
    reimbursed: true,
    files: [
      {
        name: 'blue-fern-receipt.png',
        image: true,
        lines: ['BLUE FERN NOODLE BAR', 'Dan dan noodles 14.00', 'Dumplings 9.00', 'Tea 4.00', 'Tip 7.20', 'TOTAL 37.20'],
      },
    ],
  },
  {
    vendor: 'Fabrikam Hardware',
    amount: 129.99,
    age: 63,
    category: 'Hardware',
    reimbursed: false,
    // A filename far longer than any panel row, with spaces and parentheses, the shape
    // that once broke a markdown link — see `formatAttachmentMarkdown`.
    files: [
      {
        name: 'Fabrikam Hardware Receipt (final) - Cordless Drill Invoice 2026-0042 - copy kept for the warranty claim v2.pdf',
        lines: [
          'Fabrikam Hardware',
          'Cordless drill kit 18V   129.99',
          'Warranty: 3 years from date of purchase.',
          'Keep this receipt for warranty service.',
        ],
      },
    ],
  },
  {
    vendor: 'Wide World Travel',
    amount: 318.6,
    age: 120,
    category: 'Other',
    reimbursed: false,
    // Several files on one note: the panel's list, and search naming which file matched.
    files: [
      {
        name: 'booking-confirmation.pdf',
        lines: ['Wide World Travel', 'Booking WWT-EXAMPLE-7781', 'Two nights, lakeside cabin', 'Check-in after 3pm', 'Total 318.60'],
      },
      { name: 'cancellation-policy.pdf', lines: ['Cancellation policy', 'Free cancellation up to 14 days before arrival.', 'After that, the first night is non-refundable.'] },
      { name: 'parking-pass.png', image: true, lines: ['PARKING PASS', 'Lot B', 'Valid for stay dates only'] },
    ],
  },
];

/** The cases that have broken a layout or a parser before, each in the smallest note that shows it. */
const AWKWARD = [
  {
    key: 'awkward/long-title',
    title:
      'A note whose title keeps going well past where any list row, table cell or window title could hope to fit it on a single line, to see where it truncates',
    body: 'The title is the point of this note.',
    tags: [],
    age: 21,
  },
  {
    key: 'awkward/untitled',
    title: '',
    body: 'A note with no title at all, which the list has to draw as something.',
    tags: [],
    age: 22,
  },
  {
    key: 'awkward/many-tags',
    title: 'Tagged with everything',
    body: 'Twenty-four tags, so a tag row has to wrap, scroll or summarise.',
    tags: [
      'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima',
      'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
      'a-tag-long-enough-to-need-its-own-line',
    ],
    age: 23,
  },
  {
    key: 'awkward/long-body',
    title: 'A long note',
    notebook: 'Projects',
    body: Array.from(
      { length: 40 },
      (_, i) =>
        `## Section ${i + 1}\n\nParagraph ${i + 1} of a note long enough to scroll for a while. ` +
        'It repeats on purpose: the point is the length, not the words. '.repeat(4),
    ).join('\n\n'),
    tags: ['long'],
    age: 24,
  },
  // In the trash, so the trash has something in it and emptying it has a count to name.
  {
    key: 'trash/old-draft',
    title: 'Old draft, thrown away',
    body: 'Superseded by the version in Projects.',
    tags: [],
    age: 140,
    trashed: true,
  },
  {
    key: 'trash/duplicate-receipt',
    title: 'Duplicate receipt',
    notebook: 'Receipts',
    body: 'Scanned twice by accident.',
    tags: [],
    age: 66,
    trashed: true,
    files: [{ name: 'duplicate.pdf', lines: ['Fabrikam Hardware', 'Duplicate copy', 'Total 129.99'] }],
  },
  {
    key: 'trash/restaurant',
    title: 'Moss Creek Diner (again)',
    notebook: 'Restaurants',
    body: 'Logged twice.',
    tags: [],
    fields: { Restaurant: 'Moss Creek Diner', Rating: 2 },
    age: 78,
    trashed: true,
  },
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const RECORDS = [
  ...RESTAURANTS.map(([restaurant, dish, rating, again, review, tags, age]) => ({
    key: `restaurants/${slug(restaurant)}/${slug(dish)}`,
    title: `${restaurant} — ${dish}`,
    notebook: 'Restaurants',
    body: `${review}\n\nOrdered the ${dish.toLowerCase()}.`,
    tags,
    fields: { Restaurant: restaurant, Date: day(-age), Rating: rating, Review: review, 'Would Get Again': again },
    age,
  })),
  ...WATCH.map(([title, type, status, priority, where, by, rating, age, runtime]) => ({
    key: `watch/${slug(title)}`,
    title,
    notebook: 'Watch List',
    body: `${type} — ${status.toLowerCase()}.`,
    tags: [],
    fields: {
      Type: type,
      Status: status,
      Priority: priority,
      'Where to Watch': where,
      ...(by ? { 'Recommended By': by } : {}),
      URL: `https://example.com/watch/${slug(title)}`,
      ...(rating === null ? {} : { Rating: rating }),
      'Runtime (min)': runtime,
    },
    age,
  })),
  ...COUPONS.map(([vendor, code, discount, added, expires, used, notes]) => ({
    key: `coupons/${slug(code)}`,
    title: `${vendor} — ${discount}`,
    notebook: 'Coupons',
    body: notes || `${discount} at ${vendor}.`,
    tags: [],
    fields: {
      Code: code,
      Discount: discount,
      'Date Added': day(-added),
      ...(expires === null ? {} : { Expiration: day(expires) }),
      Used: used,
      ...(notes ? { Notes: notes } : {}),
    },
    age: added,
  })),
  ...CONTACTS.map(([name, company, role, email, phone, website, categories, met]) => ({
    key: `contacts/${slug(name)}`,
    title: `${name} — ${company}`,
    notebook: 'Contacts',
    body: `${role} at ${company}.`,
    tags: [],
    fields: {
      Name: name,
      Company: company,
      Role: role,
      Email: email,
      Phone: phone,
      ...(website ? { Website: website } : {}),
      Category: categories,
      Met: day(-met),
    },
    age: met,
  })),
  ...RECEIPTS.map((r) => ({
    key: `receipts/${slug(r.files[0].name)}`,
    title: `${r.vendor} — $${r.amount.toFixed(2)}`,
    notebook: 'Receipts',
    body: `Receipt from ${r.vendor}.`,
    tags: ['receipt'],
    fields: { Vendor: r.vendor, Amount: r.amount, Date: day(-r.age), Category: r.category, Reimbursed: r.reimbursed },
    age: r.age,
    files: r.files,
  })),
  ...AWKWARD,
];
