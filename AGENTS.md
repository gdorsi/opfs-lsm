# Agents.md

We are still in the prototyping phase of the project.

Don't care about backward compatibility yet, and we can change the constraints if it would give us more performance.

Design principles:
- read/write performance above everything
- consistency should be guaranteed, persistance not
- before adding a new cache, check if we can achieve the same performance with an architectural change
- be mindful of what have in Rust and what in Typescript, don't just "go with the flow" and accept what's already there
- second guess all the previous design choices
