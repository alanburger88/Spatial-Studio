/**
 * Help text for every screen, and the studio's own words.
 *
 * Plain data, no imports: the browser help sheet reads it, and `e2e/help.spec.ts` checks it against `SCREENS` in
 * `shell/Shell.tsx` (every screen has an entry; every "where to go next" link is a real screen).
 * Each entry is written from what the screen does today (its file and its ScreenHeader subtitle) and, for features that
 * are still being built, from the design document named beside it. Do not describe anything the screen cannot do.
 */

export interface HelpLink {
  /** Screen id (S01 to S24) of the screen to go to. */
  screen: string;
  /** One short phrase: why you would go there. */
  why: string;
}

export interface HowToRead {
  /** What to look at (a short name). */
  what: string;
  /** What it tells you. */
  means: string;
}

export interface ScreenHelp {
  /** What this screen is for: one or two sentences. */
  purpose: string;
  /** What you can do here: three to five short actions. */
  actions: string[];
  /** Where to go next: one or two links. */
  next: HelpLink[];
  /** For the visual screens: how to read them. */
  read?: HowToRead[];
  /** Set where the screen, or part of it, is still being built: said plainly on the help page. */
  building?: string;
}

export const SCREEN_HELP: Record<string, ScreenHelp> = {
  S01: {
    purpose: 'The home page of the studio: every document you can work on, the two samples that come with the studio, and the place to start a new one. Pick a document here and you land on its Overview.',
    actions: [
      'Open a sample, or a document you made, to see where it stands.',
      'Start a new project from a starter template, from a description of your document, by rebuilding a PDF or Word file you already send, or from an empty page.',
      'Import a studio project file as a new draft, or import customer records.',
      'Make a copy of any project, rename or delete your own, or save one as a template, from its menu.',
      'Restore the two samples to how they shipped.',
    ],
    next: [
      { screen: 'S19', why: 'see where an open document stands and what to do next' },
    ],
  },
  S25: {
    purpose: 'The things many documents share: a brand, building blocks such as a header or a contact panel, wording with its translations, glossaries, the house wording rules and lookup tables. Each item has numbered versions; an approved version is frozen, and a document takes a newer one only through a reviewed update. The Duplicate wording view finds messages and notices that are the same or nearly the same in many documents (it compares words, not meaning), so the wording can be kept here once and linked in each document after a review.',
    actions: [
      'Choose an item to see its versions, a preview of each and every document that uses it, with those that are behind.',
      'Start a new version as a draft, or edit the draft, by typing it or taking it from a document (authors).',
      'Approve a draft to freeze it, or discard it (approvers and admins).',
      'Keep the house wording rules as an item: add, change, reorder and remove rules, and try a sentence to see which rules it breaks. Only an admin decides whether a rule is a “must” (a blocker) or a “should” (a warning).',
      'Add an item with “Add to library” in a document, with New item here, or by keeping wording that Duplicate wording found in several documents.',
    ],
    next: [
      { screen: 'S02', why: 'use a building block from the library, or add a component to it' },
      { screen: 'S19', why: 'see whether a document has library updates waiting' },
    ],
  },
  S19: {
    purpose: 'Where a document stands and what to do next. Every line is worked out from the document, its customers and its releases; nothing is stored or guessed.',
    actions: [
      'Read the status strip: review state, version, whether changes are saved, and what is in Test and Production.',
      'Follow the next steps in order. The step marked Next is the first one still to do; each has one button that opens where it is dealt with.',
      'Check the at-a-glance facts: customers that can be issued, languages, outputs and pinned tests.',
      'See the latest saves, reviews and releases under recent activity.',
    ],
    next: [
      { screen: 'S07', why: 'find coverage gaps or work on rules' },
      { screen: 'S17', why: 'deal with anything that stops a customer being issued' },
    ],
  },
  S02: {
    purpose: 'Lay out the document and edit what it says. Pick a component on the page to change its position, its text, its data and the rules that decide whether it shows.',
    actions: [
      'Select a component on the page or in the Layers list, then edit it in the panel on the right.',
      'Add components from the Components list, or a building block with From the library (it stays linked and read-only until you unlink it). Open Page setup to choose the paper, margins, page templates, columns and backgrounds, and whether an accessible PDF is required; drag the edges of the flow area or the letterhead zone, or type the measurements.',
      'Edit text, and add an alternative version of a message for a section that changes by customer.',
      'Open Styles & brand to change text styles and brand settings.',
      'Use Explore variants to see every alternative a selected section can show.',
    ],
    next: [
      { screen: 'S13', why: 'check the wording and its translations' },
      { screen: 'S03', why: 'see every alternative of a selected section' },
    ],
    read: [
      { what: 'The page', means: 'The document as the customer in the top bar would receive it. Change the customer or the output there to see it change.' },
      { what: 'First, Following and Last', means: 'The page templates. Each has its own flow area, columns, background and fixed items. The canvas shows the first page with its content; the other templates show where content continues. Page Composition Stack shows the composed pages. A component\'s Layout tab sets keep together, a new page or column, spanning the columns and how text splits.' },
      { what: 'The right panel tabs', means: 'Content edits the text and the alternatives of a message. Data & rules shows which customer values a component uses and the rules that decide it, and, when the document uses dates, the period a section is in effect. Layout sets the position, pages and columns. Review gathers what is wrong, what people have said, what a change would affect and how it reads for assistive technology.' },
    ],
  },
  S13: {
    purpose: 'Every text a customer reads, with its translation status in each language and the wording rules it must meet. Only approved wording is ever shown to customers; a person approves it.',
    actions: [
      'Search the texts and filter them by status, and open a text in context to see where the customer reads it.',
      'Add a language, then edit and approve each translation. Ask for a first-pass draft; an AI or sample draft stays a draft until a person approves it.',
      'Import translations from a CSV file, or keep a glossary of terms to translate the same way every time.',
      'Open Wording rules to see the house rules the document follows (from the library, read-only), add rules of its own, and check the wording: findings are counted by rule, a “must” is a blocker and a “should” a warning.',
      'As you type a message, a translation or the email and text message wording, the rules it breaks show under the field, with a one-click replacement where the rule gives one and “Suggest compliant wording” when an AI key is set.',
    ],
    next: [
      { screen: 'S17', why: 'see customers blocked until wording is approved' },
      { screen: 'S15', why: 'edit the email and text message wording' },
    ],
  },
  S15: {
    purpose: 'Edit the email and the text message that go with the document: the subject, the opening and closing words, which sections the email shows and in what order.',
    actions: [
      'Switch between Email and Text message.',
      'Edit the wording, and choose which sections the email shows and in what order. Sections that cannot be hidden are marked.',
      'Read the preview for the customer shown in the top bar.',
      'Take a wording suggestion, or reset to the default wording and sections.',
    ],
    next: [
      { screen: 'S10', why: 'see and download the email and text message' },
      { screen: 'S13', why: 'translate the wording' },
    ],
  },
  S07: {
    purpose: 'Decide who sees what. A rule says "when this is true for a customer, show this version of a message". Write the rules, test them against every customer, and see the exact inputs behind the current scenario. When the document uses dates, a rule can also be in effect from or until a day; a rule that is not in effect on the preview date is marked "Not in effect", never hidden.',
    actions: [
      'Add a rule, or describe one in words and review the draft.',
      'Switch between the rule Editor, the Table of all rules and the Tests.',
      'Pin a customer and the outcome you expect as a test, and see which pass.',
      'Find coverage gaps: rules, message versions and sections that no customer reaches, with a way to generate customers who reach them.',
      'Change a customer value as a what-if, to see the outcome change, without editing the document. A condition on a calculation links to how it is worked out.',
    ],
    next: [
      { screen: 'S16', why: 'change or add the customers the rules are tested with' },
      { screen: 'S03', why: 'see which alternative a rule selects' },
    ],
  },
  S16: {
    purpose: 'See, edit, add and remove the customers this document is tested with. Each customer is shown the way the data is built: sections inside sections, with lists such as transactions inside them.',
    actions: [
      'Pick a customer and read what that customer gets: the language, message versions, sections and any blocking issues.',
      'Edit values in the form, or in the JSON. Sample customers are shared by every document, so make an editable copy first.',
      'Add a customer: blank (empty values built from the data fields) or a copy of the selected one.',
      'Remove a customer you added.',
    ],
    next: [
      { screen: 'S07', why: 'test your rules against the changed customers' },
      { screen: 'S17', why: 'see which customers are stopped, and why' },
    ],
  },
  S08: {
    purpose: 'Step a customer through events over time and see what is communicated next. An event changes what the customer is sent from then on, never what was already issued.',
    actions: [
      'Replay the journey from the start.',
      'Trigger the next event and read the resulting document.',
      'Add or edit events and their effects. This is one undoable change to the document.',
      'Compare a step with the snapshot that was issued, to see whether a preview matches what the customer was given.',
    ],
    next: [
      { screen: 'S06', why: 'see how a journey step changes the pages' },
      { screen: 'S09', why: 'check the document at a journey step' },
    ],
    read: [
      { what: 'The event list', means: 'Each event is a step. Events that have not happened yet, or whose precondition is not met, are marked.' },
      { what: 'Why this variant', means: 'For the step you select, the message versions that were chosen and the rule behind each.' },
    ],
  },
  S03: {
    purpose: 'Pull one conditional section out of the page and look at it from the side: every named alternative it can show, why each appears and who receives it. When the document uses dates, an alternative or rule that is not in effect on the document\'s date is marked, and the explanation gives the dates.',
    actions: [
      'Choose a section in the Design screen, then open it here with Explore variants.',
      'Look at each alternative, and select one to see why it shows.',
      'Compare two alternatives side by side.',
      'Tilt, turn and change the depth of the view, or collapse back to the page.',
    ],
    next: [
      { screen: 'S07', why: 'change the rule behind an alternative' },
      { screen: 'S04', why: 'compare outcomes across customer types and outputs' },
    ],
    read: [
      { what: 'The layers', means: 'Each layer is one alternative of the same section. Depth shows alternatives, not pages or time.' },
      { what: 'Why this outcome', means: 'The rule that selects the alternative you have selected.' },
      { what: 'Synthetic reach', means: 'How many of the synthetic customers receive it.' },
    ],
  },
  S04: {
    purpose: 'Compare outcomes across three things at once, for example customer type, output and journey stage. Every cell is a real result for the synthetic customers, not an estimate.',
    actions: [
      'Choose the three dimensions the cube is made from.',
      'Filter to problems only, or clear the filters.',
      'Select a cell to see its outcome breakdown, the rules that matter and any issues.',
      'Open a representative customer for a cell, or open it in Exploded.',
    ],
    next: [
      { screen: 'S05', why: 'see the outcome groups across all customers' },
      { screen: 'S03', why: 'look at one section\'s alternatives' },
    ],
    read: [
      { what: 'A filled cell', means: 'At least one synthetic customer gets that combination. Its size or marking shows how many.' },
      { what: '"No matching fixture"', means: 'No synthetic customer is in that combination. It is not an error: it may be a gap in your test customers.' },
      { what: 'The table view', means: 'The same cells as a list, for keyboard use and screen readers.' },
    ],
  },
  S05: {
    purpose: 'See which outcomes customers actually get, grouped into clusters, and where the problems are.',
    actions: [
      'Look at the outcome clusters: customers who get the same message versions, sections, journey state and output.',
      'Filter, and change what size, height and colour show.',
      'Select a cluster to see its rules, representative customers and any issues.',
      'Open a representative customer, or the component, from a cluster.',
    ],
    next: [
      { screen: 'S17', why: 'deal with blocking customers' },
      { screen: 'S04', why: 'compare the same customers across dimensions' },
    ],
    read: [
      { what: 'A cluster', means: 'A group of synthetic customers who get exactly the same outcome. A bigger cluster is more customers.' },
      { what: 'Blocking and warning', means: 'Clusters with a problem are marked with a word as well as a colour.' },
      { what: 'The table', means: 'The same clusters as a list, with their share of customers.' },
    ],
  },
  S06: {
    purpose: 'See how the content flows across the printed pages. The pages are composed for real and counted again from the PDF; nothing is estimated.',
    actions: [
      'Step through the pages and open one to see what it holds.',
      'Compare the current customer with another, or with a point in the journey.',
      'Test a stress case, such as disabling a continuation, to see what moves.',
      'Recompose after a change.',
    ],
    next: [
      { screen: 'S02', why: 'change a layout constraint in the designer' },
      { screen: 'S09', why: 'check page and PDF problems' },
    ],
    read: [
      { what: 'The stack', means: 'One sheet per page, in order. A component that runs over more than one page is marked as continued.' },
      { what: 'The page count', means: 'Taken from the generated PDF, so it is what the customer would get.' },
      { what: 'The component table', means: 'Which pages each component sits on, and what moved between two compositions.' },
    ],
  },
  S17: {
    purpose: 'Everything that stops this document being issued, one entry for each cause, across every synthetic customer. Fix a cause and every customer it stopped is cleared.',
    actions: [
      'Read the summary: customers who can be issued, customers stopped, and the time of the last full check.',
      'Choose a blocker to see what is wrong, who is affected and the fixes to choose from, each with its effect.',
      'Apply a suggested fix, or open the place where it is fixed by hand. Run the full check to compose pages and compare PDF and web output.',
      'For a problem in one customer\'s data: open it in Data Explorer with the fields highlighted, or have an approver mark it a known data problem with a reason.',
      'Use "Resolve one by one" to walk through the open blockers, most customers first, and pin a test for each one fixed.',
    ],
    next: [
      { screen: 'S09', why: 'run the checks and compare outputs' },
      { screen: 'S18', why: 'release the document once nothing is blocked' },
    ],
  },
  S09: {
    purpose: 'Check the document for problems before it goes out: rules, data links, pagination, PDF and web agreement, and accessibility, including the PDF itself. The checks run on their own for the current customer and scenario, and, when the document uses dates, as issued on the preview date.',
    actions: [
      'Read the issues for this customer, or switch to all customers.',
      'Choose an issue to see its cause, who it reaches and a suggested fix with its effect.',
      'Choose which suites to run, and read the result for each.',
      'Read the PDF accessibility checks and open a failure where it is fixed.',
      'Open an issue in Blockers to resolve it.',
    ],
    next: [
      { screen: 'S17', why: 'see every blocker for every customer' },
      { screen: 'S10', why: 'look at the actual outputs' },
    ],
    read: [
      { what: 'The freshness note', means: 'Says whether the result is up to date or is being re-run after a change.' },
      { what: 'Accessibility results', means: 'Automated checks only. They are not a certification.' },
      { what: 'PDF accessibility', means: '“Checked by the studio” means the studio read its own PDF; it is not validation against PDF/UA. “Validated by veraPDF” appears only when veraPDF is installed on this machine and ran. A failure blocks the document only when an accessible PDF is required (Design, Page setup).' },
    ],
  },
  S10: {
    purpose: 'See and download the real PDF, web page, email and text message for the current customer, built from the same document. The AFP output is a simulation only.',
    actions: [
      'Look at each output for the customer and scenario chosen in the top bar.',
      'Download an output; a customer who is blocked can only get a watermarked draft.',
      'See the pages, paper and sequence details for the paged output.',
      'Look back through the export history.',
    ],
    next: [
      { screen: 'S09', why: 'check the document before exporting' },
      { screen: 'S18', why: 'hand over an approved release instead of a one-off export' },
    ],
  },
  S18: {
    purpose: 'The approved, frozen versions of this document, their stage (Test or Production) and the package to hand over to the team that produces the documents.',
    actions: [
      'Open a release to see how it was made, who approved it and its stage history.',
      'Download its package and see what is inside.',
      'Move a release to Production, if you are an administrator, or withdraw it.',
      'Compare a release with the working version or another release.',
    ],
    next: [
      { screen: 'S20', why: 'see what customers would see differently' },
      { screen: 'S21', why: 'look up what a customer was given' },
    ],
  },
  S20: {
    purpose: 'If one version replaces another, what will customers see differently, and who? Compare two releases, or the working version with a release.',
    actions: [
      'Choose a Before and an After, or swap them.',
      'Read who changes: customers grouped by the kind of change, each with its customers.',
      'Choose a customer and an output (PDF pages, web page, email or text message) to see Before and After side by side.',
      'Open what changed in the document, to trace a visible difference to the edit that caused it.',
    ],
    next: [
      { screen: 'S18', why: 'go back to the releases' },
      { screen: 'S17', why: 'see customers that are now stopped' },
    ],
    read: [
      { what: 'Before on the left, After on the right', means: 'Parts that differ are outlined on the PDF pages and the web page. The email is shown side by side without outlines, and the text message marks the changed words.' },
      { what: 'The group counts', means: 'Each group says how many of the synthetic customers are in it. Only the test customers this document has are compared.' },
      { what: 'What it does not compare', means: 'Pixels (a change that only restyles shows as a look change for everyone), the AFP simulation, and whole production runs.' },
    ],
  },
  S21: {
    purpose: 'Answers "what was this customer given, from which approved version, and why?" using a proof record. A proof record keeps fingerprints and decisions, not the customer\'s data. It shows what was produced, not that it was delivered, and it is not an archive.',
    actions: [
      'Search for a record by customer reference, release, date, proof number or run number.',
      'Read what was produced and when, and the release it came from.',
      'See, for each part of the document, the message shown and the rule that chose it.',
      'Supply the customer\'s data again to re-create the document and check that it matches. The data is not stored.',
      'Add proof records written by a runnable package, or produce documents from a release on the Releases tab to make new ones.',
    ],
    next: [
      { screen: 'S18', why: 'open the release a record came from' },
      { screen: 'S20', why: 'compare releases' },
    ],
  },
  S22: {
    purpose: 'Calculations are named values worked out from a customer\'s data, such as the days until a payment is due or the total of this month\'s fees. A calculation can be used in rules and wording wherever a data field can. When the document uses dates, the values are worked out as issued on the studio\'s preview date, the same day as the status bar and Dates.',
    actions: [
      'Add a calculation, or start from an example made from this document\'s own fields.',
      'Build it step by step from lists, or type a formula. The builder, the formula and the plain-words reading always match.',
      'See the value of each step for the current customer, and the value for every synthetic customer, including who has no value and why.',
      'Check which rules, wording and other calculations use it, each a link, before you change or remove it.',
      'Save the calculation. It is one step that Undo takes back.',
    ],
    next: [
      { screen: 'S07', why: 'use a calculation in a rule' },
      { screen: 'S23', why: 'keep a table of values that a calculation reads' },
    ],
  },
  S23: {
    purpose: 'Lookup tables are small tables kept with the document, such as a fee by tier or a notice by state. A calculation reads a value from a table. A table keyed by a range of dates is tried as issued on the studio\'s preview date.',
    actions: [
      'Add a table and say what it is looked up by (exact text, a range of numbers or a range of dates) and what values it gives.',
      'Type the rows in the grid with the keyboard, or paste them from a spreadsheet and check the preview first.',
      'See duplicate keys, overlapping ranges and gaps as you edit, and choose what happens when no row matches.',
      'Try a key to see which row matches and what it gives, then save the table.',
    ],
    next: [
      { screen: 'S22', why: 'read the table from a calculation' },
      { screen: 'S24', why: 'see what changes when a table has dated rows' },
    ],
  },
  S24: {
    purpose: 'The document\'s own date decides which dated rules, alternatives and sections are in effect; the studio never uses today\'s date. This screen says where that date comes from, sets the day every preview and check is worked out for, and shows what changes on which day.',
    actions: [
      'Choose where the document\'s date comes from: none, a date in the customer\'s data, or a date given for each run.',
      'Preview the whole studio "as issued on" a day you pick, or a day something changes and the day before it. Calculations and Lookup tables use the same day. The status bar says when a preview date is set, and clearing it there is one click.',
      'Read the timeline: each day something starts or ends, in plain words, and how many synthetic customers it reaches, with their names. A dated row of a lookup table links to its table.',
      'Fix problems in time: a message with no alternative in effect on some days, or two rules that tie only during a period.',
    ],
    next: [
      { screen: 'S07', why: 'put a rule in effect from or until a date' },
      { screen: 'S17', why: 'check for blockers as issued on a date' },
    ],
    read: [
      { what: 'The timeline', means: 'One row per day something changes, in date order. The strip above it shows the same days; the list is the full version and works with the keyboard.' },
      { what: 'Reaches', means: 'How many synthetic customers get a different document on that day than on the day before.' },
    ],
  },
  S11: {
    purpose: 'A narrated demonstration on the two sample documents. It is a demonstration, not help: it performs real changes and checks as it goes, and resets the samples when it starts.',
    actions: [
      'Start the guided demo, or restart it.',
      'Go to the next step when you are ready.',
      'Reset the demo to put the samples back.',
    ],
    next: [
      { screen: 'S19', why: 'see where a document stands' },
      { screen: 'S12', why: 'ask a question about the document' },
    ],
  },
  S12: {
    purpose: 'Describe a scenario or ask why. The assistant proposes changes and the studio\'s own engine works out their effect; nothing changes until you approve it.',
    actions: [
      'Ask about the document, or pick one of the suggested prompts.',
      'Read a proposal with its effect before and after, and approve or reject it.',
      'See which rules were involved in an answer, and open one.',
      'Check whether the built-in or an AI answer is in use (the built-in assistant is the default and always works).',
    ],
    next: [
      { screen: 'S07', why: 'open the rules the assistant mentions' },
      { screen: 'S14', why: 'see what was applied, and by whom' },
    ],
  },
  S14: {
    purpose: 'Every change is recorded: who saved, restored, reviewed, commented, imported or exported, and when. Entries say what happened without copying document text or comments.',
    actions: [
      'Read what happened, newest first, and filter by person, kind of event and period.',
      'Search the log, or ask about it in plain words.',
      'Switch to all projects.',
      'Administrators can also manage users and roles.',
    ],
    next: [
      { screen: 'S19', why: 'see where the document stands now' },
      { screen: 'S18', why: 'see the releases' },
    ],
  },
};

export interface GlossaryEntry {
  term: string;
  means: string;
  /** Where the word is explained or used, as a screen id. */
  screen?: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: 'Blocker', screen: 'S17', means: 'A problem that stops a document being issued to a customer, such as missing approved wording, rules that tie, values that do not add up, a broken data link or content that runs off the page. The studio lists one blocker for each cause and says how many customers it stops. Fix the cause and they are all cleared.' },
  { term: 'Known data problem', screen: 'S17', means: 'The only exception to "a blocker must be fixed", and a narrow one. It applies to one customer and one problem caused by that customer\'s own data, is set aside by an approver with a reason, and never applies to a blocker in the document itself. It is listed on the approval screen and in every release.' },
  { term: 'Release', screen: 'S18', means: 'An approved, numbered, frozen version of a document. Approving the document makes the next release; nothing can change a release afterwards, so a change is always a new release. The receiving team gets a release, never a draft.' },
  { term: 'Test and Production', screen: 'S18', means: 'The two stages a release moves through. A new release starts in Test. Moving it to Production is for administrators, and each move is recorded with who and when.' },
  { term: 'Proof record', screen: 'S21', means: 'A record of what was produced for one customer, which release it came from and which alternative each part showed and why. It keeps fingerprints and decisions, not the customer\'s data.' },
  { term: 'Pinned test', screen: 'S07', means: 'A customer and the outcome you expect for them, saved with the document ("Pin as a test" in Rules). The studio runs it again after every change, so a fix that later breaks shows up straight away.' },
  { term: 'Synthetic customer', screen: 'S16', means: 'A made-up customer the document is tested with. Every customer, account and claim in the studio is fictional, and counts of customers say "synthetic" so you do not read them as real people.' },
  { term: 'Alternative (variant)', screen: 'S03', means: 'One of the named versions a section or message can show, for example a standard reminder or a payment support message. Rules choose which alternative a customer gets.' },
  { term: 'The document\'s date', screen: 'S24', means: 'The day a document is issued on, as far as its rules are concerned: a date in the customer\'s data or a date given for each run, never today\'s date. Rules, alternatives and sections can be in effect from or until a day; "As issued on" previews the studio on a day you pick.' },
  { term: 'Coverage', screen: 'S07', means: 'Whether every rule, message version and section is reached by at least one customer. A gap is one that no customer reaches, so nobody has checked it. "Find coverage gaps" in Rules lists them and can generate customers who reach them.' },
];

/** The screen ids that have help, for tests and for the list in the help sheet. */
export const HELP_SCREEN_IDS = Object.keys(SCREEN_HELP);
