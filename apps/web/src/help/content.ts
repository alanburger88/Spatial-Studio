/**
 * Help text for every screen, and the studio's own words.
 *
 * Plain data, no imports: the browser help sheet reads it, and `e2e/help.spec.ts` checks it against `SCREENS` in
 * `shell/Shell.tsx` (every screen has an entry; every "where to go next" link is a real screen).
 * Each entry is written from what the screen does today (its file and its ScreenHeader subtitle) and, for features that
 * are still being built, from the design document named beside it. Do not describe anything the screen cannot do.
 */

export interface HelpLink {
  /** Screen id (S01 to S21) of the screen to go to. */
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
      'Start a new project from a starter template, from a description of your document, or from an empty page.',
      'Import a studio project file as a new draft, or import customer records.',
      'Make a copy of any project, rename or delete your own, or save one as a template, from its menu.',
      'Restore the two samples to how they shipped.',
    ],
    next: [
      { screen: 'S19', why: 'see where an open document stands and what to do next' },
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
      'Add components from the Components list, and set the page width, grid and snapping.',
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
      { what: 'The right panel tabs', means: 'Data shows which customer values a component uses. Rules shows the rules that decide it. Blockers, Comments, Impact and Accessibility show what is wrong, what people have said, what a change would affect and how it reads for assistive technology.' },
    ],
  },
  S13: {
    purpose: 'Every text a customer reads, with its translation status in each language. Only approved wording is ever shown to customers; a person approves it.',
    actions: [
      'Search the texts and filter them by status.',
      'Add a language, then edit and approve each translation.',
      'Ask for a first-pass draft. An AI or sample draft is only ever a draft until a person approves it.',
      'Import translations from a CSV file, or keep a glossary of terms to translate the same way every time.',
      'Open a text in context to see where the customer reads it.',
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
    purpose: 'Decide who sees what. A rule says "when this is true for a customer, show this version of a message". Write the rules, test them against every customer, and see the exact inputs behind the current scenario.',
    actions: [
      'Add a rule, or describe one in words and review the draft.',
      'Switch between the rule Editor, the Table of all rules and the Tests.',
      'Pin a customer and the outcome you expect as a test, and see which pass.',
      'Find coverage gaps: rules, message versions and sections that no customer reaches, with a way to generate customers who reach them.',
      'Change a customer value as a what-if, to see the outcome change, without editing the document.',
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
    purpose: 'Pull one conditional section out of the page and look at it from the side: every named alternative it can show, why each appears and who receives it.',
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
    purpose: 'Check the document for problems before it goes out: rules, data links, pagination, PDF and web agreement, and accessibility. The checks run on their own for the current customer and scenario.',
    actions: [
      'Read the issues for this customer, or switch to all customers.',
      'Choose an issue to see its cause, who it reaches and a suggested fix with its effect.',
      'Choose which suites to run, and read the result for each.',
      'Open an issue in Blockers to resolve it.',
    ],
    next: [
      { screen: 'S17', why: 'see every blocker for every customer' },
      { screen: 'S10', why: 'look at the actual outputs' },
    ],
    read: [
      { what: 'The freshness note', means: 'Says whether the result is up to date or is being re-run after a change.' },
      { what: 'Accessibility results', means: 'Automated checks only. They are not a certification.' },
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
  { term: 'Coverage', screen: 'S07', means: 'Whether every rule, message version and section is reached by at least one customer. A gap is one that no customer reaches, so nobody has checked it. "Find coverage gaps" in Rules lists them and can generate customers who reach them.' },
];

/** The screen ids that have help, for tests and for the list in the help sheet. */
export const HELP_SCREEN_IDS = Object.keys(SCREEN_HELP);
