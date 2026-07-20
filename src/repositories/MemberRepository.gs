'use strict';

/**
 * Find-or-create bridge between a Clawbot customer profile (name + phone,
 * collected once per customer, and re-collectable any time via /thongtin --
 * see core/orderService.js's profile-collection step) and a POS "member"
 * record. Injected into OrderService as the optional `memberRepository`
 * dependency; when absent, OrderService simply skips POS member
 * resolution/sync and only keeps the name/phone locally.
 *
 * Lookup-before-create: the POS webhook has no "find member by phone"
 * action, only `listMembers(query)` (substring match across name/phone/code).
 * `resolve()` searches by phone and only creates a new member when nothing
 * matches -- this is a best-effort de-dup, not a hard uniqueness guarantee
 * (see BotOrderWebhookClient.gs's createMember comment on the race).
 * `update()` is the counterpart used once a memberId is already known, to
 * push a later name/phone edit to the same POS member instead of creating
 * a duplicate.
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

  // Syncs a name/phone change to an already-linked POS member (customer
  // proactively re-ran the profile-collection flow via /thongtin -- see
  // core/orderService.js). Unlike resolve(), this never creates a new member;
  // the caller only invokes it when a memberId is already on file.
  function update(memberId, profile) {
    if (!memberId) return null;
    var updated = BotOrderWebhookClient.updateMember(memberId, {
      name: (profile && profile.name) || '',
      phone: (profile && profile.phone) || null
    });
    return { memberId: updated.memberId || memberId };
  }

  return Object.freeze({ resolve: resolve, update: update });
}

if (typeof module !== 'undefined' && module.exports) module.exports = MemberRepository;
