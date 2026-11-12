<!-- one sentence: what fiat does wrong today, or cannot express today, and what this pull request makes fiat do. -->

## The Issue

<!-- one simplest real example, run on main and on the branch: the request the caller gives, the body main sends, the body the branch sends as a diff against main's body, and one or two sentences on what differs and why it matters. for a new feature, show what a caller cannot express today. print all json one key per line.
above every payload block, say who sends it, to whom, whether it is a request or a response, and whether it is the whole body or a part nested inside one; name each party by its role (the proxy's client, the proxy, Anthropic's API), not "the caller".  And if you are identifying "the proxy" you should define what it means.  Pronouns should only be used with clear definitions of what they refer to -->

## Op Changes

<!-- each heading only when appropriate
under each heading, show three labeled blocks for one relevant example payload: **In** (what the transform receives), **Out** (a highlighted diff between what the transform returns on main and this branch) then one sentence on what the difference means.
if seeing the impacts of any layer for multiple dialects is important, include a section per dialect that needs to be shown
above every payload block, say who sends it, to whom, whether it is a request or a response, and whether it is the whole body or a part nested inside one; name each party by its role (the proxy's client, the proxy, Anthropic's API), not "the caller".
-->

### Wire -> Lower (dialect)

### Lower -> Higher (dialect)

### Higher -> Lower (dialect)

### Lower -> Wire (dialect)

<details>
<summary>everything else</summary>

<!-- other questions, side effects.  No test or lint outputs or whatever, those should be covered by CI -->

</details>
