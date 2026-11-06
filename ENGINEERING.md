# Engineering Principles & Development Standards

**Version:** 1.0  
**Purpose:** Build software that is correct, understandable, maintainable, testable, and enjoyable to work on.

---

## 1. Our Philosophy

We build software for people who will need to understand, maintain, extend, and debug it.

Our goal is not to write the most sophisticated code. Our goal is to build the simplest system that correctly satisfies the requirements while remaining easy to change.

We draw on the principles of Robert C. Martin, Kent Beck, Martin Fowler, and *The Pragmatic Programmer*.

We value:

- Clarity over cleverness.
- Simplicity over unnecessary abstraction.
- Explicit behavior over hidden magic.
- Cohesion over convenience.
- Composition over inheritance.
- Small, reversible changes over large rewrites.
- Evidence over assumptions.
- Working software over architectural theater.

**Code quality is not measured by the number of abstractions, interfaces, classes, or design patterns.**

Good code makes responsibilities obvious, dependencies intentional, behavior predictable, and changes safe.

## 2. The Four Rules of Simple Design

Inspired by Kent Beck's principles of Simple Design, in priority order:

1. **Passes the tests.** The system behaves correctly and satisfies its requirements.
2. **Reveals intention.** Names, interfaces, and structure explain what the code does and why.
3. **Contains no unnecessary duplication.** Knowledge and business rules have a clear owner.
4. **Contains no unnecessary elements.** Every abstraction, function, class, and dependency earns its existence.

Do not sacrifice correctness for elegance.

Do not sacrifice readability to reduce line count.

Do not create abstractions merely to demonstrate architectural sophistication.

When two designs are equally correct, prefer the one that is easier to understand and change.

## 3. SOLID Principles

Apply SOLID pragmatically.

### Single Responsibility Principle

A module, class, or function should have one coherent reason to change.

Separate responsibilities that evolve independently.

A large cohesive service is preferable to many tiny classes with artificial boundaries. However, a service combining unrelated business policies, persistence, transport handling, and presentation is a warning sign.

### Open/Closed Principle

Prefer extension through composition and well-defined behavior boundaries.

Avoid repeatedly modifying large conditional dispatchers when new behavior can be added cleanly through an existing contract.

Do not invent extensibility points for hypothetical future requirements.

### Liskov Substitution Principle

Implementations must honor the behavioral expectations of their contracts.

Substitution must preserve invariants, not merely satisfy TypeScript signatures.

### Interface Segregation Principle

Prefer small, cohesive interfaces based on actual consumer needs.

Do not force consumers to depend on methods they do not use.

Avoid creating interfaces for classes that have no meaningful alternative implementation or test boundary.

### Dependency Inversion Principle

High-level business rules must not depend on low-level implementation details.

Domain behavior must remain independent of persistence engines, web frameworks, external providers, and UI technologies.

Dependencies should point toward stable business policies.

## 4. Architecture and Boundaries

Organize code around business capabilities and responsibilities, not merely frameworks or technical layers.

Where appropriate, distinguish:

**Domain**
- Business entities and value objects
- Invariants and policies
- Domain operations
- Domain events

**Application**
- Use cases and workflows
- Authorization coordination
- Transaction coordination
- Domain operation orchestration
- Explicit application contracts

**Infrastructure**
- Databases and repositories
- External APIs
- Message transports
- File systems
- Provider integrations

**Presentation / Transport**
- HTTP controllers
- User interfaces
- CLI handlers
- Serialization and validation at external boundaries

Infrastructure may depend on domain contracts. Domain rules must not depend on infrastructure.

Not every feature needs every layer.

A simple feature should remain simple.

### Dependency Injection

Prefer explicit constructor dependencies over global state, service locators, hidden singletons, or scattered dependency construction.

Use dependency injection where it clarifies ownership, lifecycle, substitution, and testing.

Do not create an interface and dependency-injection registration for every trivial helper.

### Modular Design

Modules must expose intentional public capabilities.

Avoid circular dependencies, deep imports into another module's internals, and duplicated domain rules.

Cross-module interactions should occur through clear application contracts.

Do not create microservices simply to achieve modularity. A well-structured modular monolith is often the better design.

## 5. Code Readability

Code is read far more frequently than it is written.

### Naming

Use names that communicate intent.

Prefer domain terminology over vague technical naming.

Avoid ambiguous names such as `Manager`, `Processor`, `Helper`, `Utils`, or `DataService` when a more precise responsibility can be expressed.

Use consistent terminology across the codebase.

### Functions and Methods

Functions should perform a cohesive operation.

Prefer small functions when extraction improves understanding.

Avoid functions with multiple unrelated responsibilities, hidden side effects, excessive parameters, and deeply nested conditional logic.

Do not split straightforward code into many functions that make the flow harder to follow.

### Types and Contracts

Use explicit types at important boundaries.

Avoid `any`, unsafe casts, implicit structural assumptions, and loosely defined data objects.

Represent meaningful states explicitly.

Prefer discriminated unions when mutually exclusive outcomes exist.

Make invalid states difficult to represent and reject them at appropriate boundaries.

### Errors

Failures must be explicit and actionable.

Do not swallow exceptions, hide contradictory state, or return success-shaped responses after failure.

Preserve useful diagnostic context without exposing sensitive information.

### Comments

Comments should explain intent, constraints, tradeoffs, or non-obvious decisions.

Do not use comments to repeat what readable code already says.

If code requires lengthy explanations to understand ordinary behavior, reconsider its structure.

## 6. Business Rules and Data Integrity

Every business invariant needs one authoritative owner.

Do not duplicate authoritative calculations or policies across frontend, backend, persistence, and AI layers.

Validate untrusted inputs at system boundaries.

Protect state transitions and side effects with appropriate transaction and concurrency guarantees.

Use idempotency for operations that may be retried.

Represent money, quantities, units, dates, and other precision-sensitive values using appropriate types and explicit policies.

Do not rely on floating-point arithmetic when exact monetary correctness is required.

Persistence constraints should reinforce domain invariants, not replace them.

External systems and AI models may propose operations; trusted application code must validate and execute them.

## 7. Tests as a Design Tool

Testing is part of software design, not a final verification ceremony.

Use the Red–Green–Refactor cycle where it improves development:

1. Write a failing test describing the required behavior.
2. Implement the smallest correct change.
3. Refactor while preserving behavior.

For existing features, characterize current behavior before risky refactoring.

### Test Responsibilities

**Unit tests:** Verify domain rules, value objects, state transitions, and pure logic.

**Application tests:** Verify use-case orchestration, contracts, error handling, and authorization decisions.

**Integration tests:** Verify persistence, transactions, concurrency, external adapter behavior, and real framework integration.

**Contract tests:** Verify data exchanged between independently maintained components.

**End-to-end tests:** Verify actual user journeys through the integrated application.

Use the lowest-cost test that gives meaningful confidence, and add higher-level tests where integration risk requires them.

### Test Quality

Tests should:

- Express business behavior.
- Cover important edge cases.
- Verify failures and rejected operations.
- Remain deterministic where possible.
- Avoid unnecessary mocking.
- Be understandable without inspecting implementation details.
- Detect meaningful regressions rather than simply confirming current code structure.

Do not rewrite tests merely to make an incorrect implementation pass.

A large test count does not prove product quality.

Mocked integration is not real integration.

A successful API response is not proof of a successful user experience.

## 8. Refactoring Discipline

Refactoring changes internal structure while preserving externally observable behavior.

Refactor continuously, but with clear boundaries and evidence.

Before refactoring:

- Identify the actual maintainability problem.
- Establish existing behavior through tests.
- Define the intended improvement.
- Understand the dependencies and callers.

During refactoring:

- Make small, reviewable changes.
- Preserve public contracts unless explicitly changing them.
- Avoid mixing unrelated feature development with structural changes.
- Reuse existing code when appropriate.
- Remove superseded code and duplication.

After refactoring:

- Run relevant regression tests.
- Review the complete diff.
- Confirm the resulting design is actually simpler.
- Verify that no unnecessary abstraction was introduced.

**Moving code between files is not automatically a design improvement.**

Extraction must improve cohesion, dependency direction, discoverability, or testability.

## 9. Security and Reliability

Security is a fundamental design constraint.

Use least privilege and deny-by-default authorization where appropriate.

Never trust client-provided identifiers, prices, permissions, or state transitions without validation.

Scope access according to the authenticated principal and business context.

Never commit credentials or expose secrets in logs.

Use bounded retries, timeouts, and concurrency for external operations.

Design critical workflows to handle partial failures and duplicate requests.

Do not weaken security or data-integrity checks to make development easier.

At the same time, avoid unnecessary security bureaucracy that prevents ordinary authorized development.

## 10. Avoid Overengineering

Do not introduce:

- Interfaces without a real boundary.
- Generic repositories for trivial persistence operations.
- Abstract factories without a meaningful creation problem.
- Configurable strategy systems for one fixed behavior.
- Plugin frameworks without actual plugins.
- Distributed services without operational need.
- Premature caching.
- Generic event buses for simple direct interactions.
- Multiple layers that merely forward arguments.
- Speculative compatibility code.
- Frameworks built around imaginary future requirements.

Apply YAGNI: You Aren't Gonna Need It.

Apply DRY to duplicated knowledge and business rules, not merely to similar-looking lines of code.

A small amount of local duplication can be preferable to an incorrect shared abstraction.

Prefer concrete implementations until variation becomes real and meaningful.

## 11. Documentation as an Engineering Deliverable

Repository documentation is the durable source of truth.

A development session must not depend on previous chat conversations.

Maintain:

- Architecture and dependency boundaries
- Important architectural decisions
- Actual implementation state
- Verified behavior and test evidence
- Known limitations and blocked work
- Operational procedures
- Current roadmap and next milestone

Distinguish clearly between:

- **Implemented**
- **Verified**
- **Proposed**
- **Blocked**
- **Not deployed**

Update relevant canonical documentation alongside implementation changes.

Do not generate a new architecture report or roadmap when an existing authoritative document should be updated.

Documentation must describe the code that exists, not the code we wish existed.

## 12. Incremental Development Workflow

### Before implementation

1. Read repository instructions and relevant canonical documentation.
2. Inspect the current Git working tree.
3. Understand the existing architecture and related code.
4. Identify the smallest coherent requirement.
5. Define observable acceptance criteria.
6. Identify risks to existing behavior.

### During implementation

1. Preserve established architectural boundaries.
2. Reuse suitable existing components and services.
3. Implement one coherent change at a time.
4. Add tests appropriate to the behavior.
5. Avoid speculative functionality and unrelated refactoring.
6. Keep commercial and security invariants intact.

### Before completion

1. Run relevant tests.
2. Run typechecking, linting, formatting, and builds as applicable.
3. Review the entire diff.
4. Inspect new abstractions and duplicated rules.
5. Verify the actual integrated behavior where possible.
6. Update relevant canonical documentation.
7. Commit only reviewed, coherent changes when requested.

Preserve unrelated changes.

Do not overwrite shared work, reset databases, deploy, or push without authorization.

## 13. Definition of Done

A task is not complete merely because the code compiles or tests pass.

A change is complete when:

- The required behavior is implemented.
- The design respects existing boundaries.
- Business rules have a clear owner.
- The implementation is understandable and maintainable.
- Relevant regression tests pass.
- Required integration behavior has been verified.
- Security and data-integrity constraints remain intact.
- The final diff has been reviewed.
- Canonical documentation reflects reality.
- Remaining limitations are explicitly reported.

When verification is blocked, report the exact blocker. Never claim unperformed verification.

## 14. Mandatory Design Review

Before declaring a task complete, answer:

**Responsibility**
- Does every new responsibility belong where it was implemented?
- Is any module doing unrelated work?

**Dependencies**
- Do dependencies point in the correct direction?
- Have hidden coupling or circular dependencies been introduced?

**Simplicity**
- Could the same behavior be implemented more clearly?
- Did we add unnecessary layers, interfaces, or configuration?

**Correctness**
- Are business invariants protected?
- Are errors, edge cases, and concurrency handled appropriately?

**Testing**
- Do tests verify actual behavior?
- What remains unverified?

**Maintainability**
- Would a developer unfamiliar with this change understand it?
- Can we modify this behavior later without touching unrelated modules?

If a design concern remains, identify it explicitly rather than concealing it behind a passing test suite.

---

## Final Principle

**Make it work. Make it right. Keep it simple.**

Our engineering goal is not architectural perfection.

It is software that remains trustworthy, understandable, and pleasant to evolve—one small, well-tested change at a time.
