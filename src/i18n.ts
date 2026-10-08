export type Locale = 'en' | 'zh-CN';

export function resolveLocale(value?: string | null): Locale {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh_cn' || normalized === 'cn') {
    return 'zh-CN';
  }
  return 'en';
}

export const DEFAULT_LOCALE = resolveLocale(
  (import.meta.env.VITE_DEFAULT_LOCALE as string | undefined) ??
  (import.meta.env.APP_DEFAULT_LANGUAGE as string | undefined) ??
  'en'
);

export const translations: Record<Locale, Record<string, string>> = {
  en: {
    appName: 'ChinaPoll',
    tagline: 'Public opinion made visible',
    home: 'Home',
    allPolls: 'All Polls',
    about: 'About',
    propose: 'Propose',
    openPolls: 'Open polls',
    totalVotes: 'Total votes',
    modes: 'Modes',
    vote: 'Vote',
    approve: 'Approve',
    oppose: 'Oppose',
    neutral: 'Neutral',
    deadline: 'Deadline vote',
    evergreen: 'Evergreen vote',
    votes: 'votes',
    openSource: 'Open source code',
    noLogin: 'no login required',
    oneToken: 'one token per device',
    publicResults: 'public results',
    heroTitle: 'Continuous voting · anonymous · open and auditable',
    heroBody: 'Users can vote on public issues without logging in and review the results in an open format.',
    aboutTitle: 'About ChinaPoll',
    aboutBody: 'ChinaPoll combines continuous voting, anonymous participation, and public auditability into a practical public-opinion platform.',
    aboutPointOne: 'One device, one vote via a random client token and server-side uniqueness checks.',
    aboutPointTwo: 'No login or personal data collection.',
    aboutPointThree: 'Public snapshots and hashable records for verification.',
    proposalTitle: 'Submit a proposal',
    proposalBody: 'To add a new public issue, it should meet these minimum checks:',
    proposalRuleOne: 'It can be stated in one sentence.',
    proposalRuleTwo: 'It can produce a clear yes/no/neutral outcome.',
    proposalRuleThree: 'It avoids personal attacks.',
    proposalRuleFour: 'It is not a duplicate of an existing issue.',
    proposalRuleFive: 'It is relevant to public policy or civic discussion.',
    issuePrefix: 'Issue',
    anonymousComment: 'Anonymous comment (optional, 140 characters max)',
    commentPlaceholder: 'Keep it public and avoid identifying details.',
    privacyText: 'We store only a random token hash and a coarse network bucket. No name, email, or full IP address.',
    voteRecord: 'Vote recorded',
    submitFailed: 'Submit failed',
    homeLinkLabel: 'Go to the home page'
  },
  'zh-CN': {
    appName: 'ChinaPoll',
    tagline: '让民意被看见',
    home: '首页',
    allPolls: '全部议题',
    about: '关于',
    propose: '提案',
    openPolls: '开放议题',
    totalVotes: '总票数',
    modes: '模式',
    vote: '投票',
    approve: '赞同',
    oppose: '反对',
    neutral: '中立',
    deadline: '限时投票',
    evergreen: '长期开放',
    votes: '票',
    openSource: '代码开源',
    noLogin: '无需登录',
    oneToken: '一机一票',
    publicResults: '公开结果',
    heroTitle: '持续投票 · 完全匿名 · 开源可审计',
    heroBody: '用户无需登录，即可对公开议题投出赞同 / 反对 / 中立票，并查看公开结果。',
    aboutTitle: '关于 ChinaPoll',
    aboutBody: '平台旨在把持续投票、完全匿名和公开审计结合起来，以一种更稳健的方式呈现公共议题民意。',
    aboutPointOne: '一机一票：客户端随机 token + 服务端唯一约束。',
    aboutPointTwo: '零登录：无姓名、邮箱、完整 IP 存储。',
    aboutPointThree: '数据公开：CSV、快照与哈希链可复核。',
    proposalTitle: '提案页',
    proposalBody: '提交一个公开议题，新议题至少满足以下审核条款：',
    proposalRuleOne: '一句话能表述清楚。',
    proposalRuleTwo: '能投出“是/否/中立”结果。',
    proposalRuleThree: '不含人身攻击。',
    proposalRuleFour: '不与已有议题重复。',
    proposalRuleFive: '范围限于公共议题。',
    issuePrefix: '议题',
    anonymousComment: '匿名留言（可选，140 字内）',
    commentPlaceholder: '内容公开，请勿包含可识别信息。',
    privacyText: '我们只存：随机令牌哈希 + 模糊网段 · 不收姓名邮箱 · 代码开源。',
    voteRecord: '已投票',
    submitFailed: '提交失败',
    homeLinkLabel: '返回首页'
  }
};

export function getLocaleText(locale: Locale, key: string): string {
  return translations[locale]?.[key] ?? translations.en[key] ?? key;
}
