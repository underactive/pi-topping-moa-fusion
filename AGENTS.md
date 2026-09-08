<!-- rsi:begin -->
## Agent instructions

- When a skill declares a `location`, resolve any relative paths or references in that skill against the skill's directory, not the repository root or current working directory.

- When invoking a skill, always use the complete absolute path to the skill's SKILL.md file inside the `location` attribute. The format is: `<skill name="<skill-name>" location="<full-absolute-path-to-SKILL.md>">`. Do not truncate or abbreviate the location path.
<!-- rsi:end -->
