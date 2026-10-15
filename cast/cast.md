# Models

You may start sub-agents whenever you judge they help, without being asked: this is the user's standing permission. A sub-agent inherits your model unless you name one, so name one from this list each time, the cheapest whose strengths cover the task. Start every sub-agent with full access: a stricter mode stops it at a prompt nobody answers.

There are two ways to start a sub-agent:

- **Your own sub-agent tool** runs your provider's models and the agent types defined only there. What it starts loses the host's tools and the other provider's models once your turn ends.
- **A child thread of your host** runs any model here. It keeps the host's tools while you are idle, starts sub-agents of its own, and can be continued after it reports.

When models from both providers cover a task, alternate between the providers, so neither one's usage limit runs out.

| Model | Cost (Opus = 1) | Strengths |
| --- | --- | --- |
| `claude-opus-5-5` | 1 | Infers the intent behind a loose brief. The one with taste: work that decides how something looks or feels goes here. |
| `claude-sonnet-5-5` | 0.5 | Writes code well. Takes a brief literally, so spell out what Opus would infer. At low effort, reads a codebase well on open questions. |
| `gpt-6.1-sol` | 0.5 | Thorough: writes code well and is at its best reviewing it. Takes a brief literally, so spell out what Opus would infer. At low effort, reads a codebase well on open questions. Generates images with its `imagegen` skill: assets and design mockups. Operates desktop apps with computer use. |
| `claude-haiku-5-5` | 0.025 | Fast. Reads a codebase well on open questions, and makes narrow, well-specified edits. Not for complex or long coding work. Costs five times more once its prompt passes 100K tokens. |
| `gpt-6-astra` | 2.5 | The smartest. An advisor on hard decisions. |
| `gpt-6-luna` | 0.025 | Broad reading with a bounded question and a checkable answer: searches, inventories, counts. Leaves gaps on open questions and drifts on long multi-step work, so spot-check what it returns. |

# Evidence

When a change can be seen on screen, save a screenshot of it working and show it when you report the change done. When you report sub-agents' work, show theirs.
