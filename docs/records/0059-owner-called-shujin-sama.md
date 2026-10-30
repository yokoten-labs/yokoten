# 0059 The Chinese docs call the owner 主人様

Status: accepted
Date: 2026-10-30 (UTC)

## Context
The zh-CN guide and standard called the project's owner 主人 (27 and 6 times). The owner asked for an anime-style form of address, after the Japanese ご主人様. On 2026-10-30 (UTC) the owner chose 主人様 from three options: 主人様, sama alone, and 主人 sama.

A reviewer of the pull request that made the change (PR #1259) asked twice to revert it, reading 主人様 as a Japanese word slipped into Chinese by mistake. It is a choice, so it is written down here.

## Decision
- The zh-CN docs call the owner, the person who decides, 主人様.
- Where 主人 means the owner of a file in CODEOWNERS, or GitHub's account that owns a repo, it stays 主人: that is a technical term, not a form of address.
- English keeps "the owner"; the Japanese docs keep オーナー.
- A reviewer does not ask to revert 主人様. A change to the word is a new record.

## Options not taken
- **sama alone** ("请 sama 来跑"): sama is a suffix in Japanese and reads oddly alone; Latin letters inside a Chinese sentence slow a beginner down.
- **主人 sama**: mixes three scripts in one name.
- **主人 as before**: plain, but reads like a servant's word for a master, without the warmth the owner wants.

## Consequences
- The zh-CN docs have a voice of their own, in line with the shiba mascot.
- Readers who know no anime may pause once at 様; the guide's terms list at the top (主人様、lead、worker) explains it.
- Issue #1260 lets each user choose the name yokoten uses for them: English defaults to "the owner", Chinese to 主人様.
