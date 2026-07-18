'use strict';

/**
 * Find-or-create bridge between a Clawbot customer profile (name + phone,
 * collected once per customer -- see core/orderService.js's profile-collection
 * step) and a POS "member" record. Injected into OrderService as the
 * optional `memberRepository` dependency; when absent, OrderService simply
 * skips POS member resolution and only keeps the name/phone locally.
 *
 * Lookup-before-create: the POS webhook has no "find member by phone"
 * action, only `listMembers(query)` (substring match across name/phone/code).
 * `resolve()` searches by phone and only creates a new member when nothing
 * matches -- this is a best-effort de-dup, not a hard uniqueness guarantee
 * (see BotOrderWebhookClient.gs's createMember comment on the race).
 */
function MemberRepository() {
  function resolve(profile) {
    if (!profile || !profile.phone) return null;
    var matches = BotOrderWebhookClient.listMembers(profile.phone);
    var existing = matches.find(function (member) { return member.phone === profile.phone; });
    if (existing) return { memberId: existing.memberId };
    var created = BotOrderWebhookClient.createMember({
      name: profile.name || '',
      phone: profile.phone
    });
    return { memberId: created.memberId };
  }

  return Object.freeze({ resolve: resolve });
}

if (typeof module !== 'undefined' && module.exports) module.exports = MemberRepository;
