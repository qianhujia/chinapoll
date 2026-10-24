// The About page copy, shared by the client page and the server-rendered first
// paint so a visitor with JavaScript disabled, a crawler, and a browser all read
// the same explanation of how the site works. Each entry names i18n keys only; the
// renderers look them up in the site's locale (see public/i18n).

export interface AboutSection {
  /** i18n key of the section heading. */
  readonly title: string;
  /** i18n keys of the bullet points, shown in order. */
  readonly points: readonly string[];
}

export const ABOUT_SECTIONS: readonly AboutSection[] = [
  {
    // How a visitor votes, and why the counts appear only above the thresholds.
    title: 'aboutVotingTitle',
    points: ['aboutVotingOpen', 'aboutVotingOnce', 'aboutVotingBallots']
  },
  {
    // What needs an account and what the account can do afterwards.
    title: 'aboutAccountsTitle',
    points: ['aboutAccountsNeeded', 'aboutAccountsPseudonymous', 'aboutAccountsDashboard']
  },
  {
    // From submission to publication, and how a poll is identified.
    title: 'aboutSubmittingTitle',
    points: ['aboutSubmittingReview', 'aboutSubmittingNumber', 'aboutSubmittingTopic']
  },
  {
    // Comments, reports, and what moderation does with them.
    title: 'aboutModerationTitle',
    points: ['aboutModerationSignedIn', 'aboutModerationReport', 'aboutModerationAutoHide']
  },
  {
    // What is stored, what is not, and how views are counted.
    title: 'aboutPrivacyTitle',
    points: ['aboutPrivacyStored', 'aboutPrivacyNetwork', 'aboutPrivacyViews']
  },
  {
    // The signed snapshot chain and how long data is kept.
    title: 'aboutAuditTitle',
    points: ['aboutAuditSnapshots', 'aboutAuditVerify', 'aboutAuditRetention']
  }
];