```markdown
# quantflow-pro Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `quantflow-pro` TypeScript codebase. You'll learn about file organization, import/export styles, commit practices, and how to write and run tests. While no specific frameworks or automated workflows are detected, this guide will help you maintain consistency and productivity in the project.

## Coding Conventions

### File Naming
- **Style:** camelCase
- **Example:**  
  - `dataProcessor.ts`
  - `userProfileManager.ts`

### Imports
- **Style:** Relative imports
- **Example:**
  ```typescript
  import { calculateRisk } from './riskCalculator';
  ```

### Exports
- **Style:** Named exports
- **Example:**
  ```typescript
  export function calculateRisk(data: DataSet): RiskResult {
    // implementation
  }
  ```

### Commit Messages
- **Style:** Freeform, no enforced prefixes
- **Average Length:** ~19 characters
- **Example:**  
  - `fix bug in parser`
  - `add new risk model`

## Workflows

### Adding a New Module
**Trigger:** When you need to introduce a new feature or utility.
**Command:** `/add-module`

1. Create a new file using camelCase (e.g., `newFeature.ts`).
2. Implement your logic using named exports.
3. Import dependencies using relative paths.
4. Write corresponding tests in a `*.test.ts` file.
5. Commit your changes with a concise, descriptive message.

### Refactoring Existing Code
**Trigger:** When improving or restructuring code without changing its external behavior.
**Command:** `/refactor`

1. Identify the target files and functions.
2. Refactor code, maintaining camelCase file naming and relative imports.
3. Update exports to remain named.
4. Run all relevant tests to ensure nothing is broken.
5. Commit with a clear message describing the refactor.

### Writing and Running Tests
**Trigger:** When adding new features or fixing bugs.
**Command:** `/test`

1. Create or update a test file matching `*.test.ts`.
2. Write tests for all new or changed functionality.
3. Use the project's preferred testing tool (framework not specified—consult team if unsure).
4. Run tests and ensure all pass before committing.

## Testing Patterns

- **Test File Naming:**  
  - Use the pattern `*.test.ts` (e.g., `riskCalculator.test.ts`).
- **Framework:**  
  - Not specified; follow existing patterns or consult the team.
- **Example Test File:**
  ```typescript
  import { calculateRisk } from './riskCalculator';

  describe('calculateRisk', () => {
    it('should return correct risk for valid input', () => {
      const result = calculateRisk(sampleData);
      expect(result).toBe(expectedRisk);
    });
  });
  ```

## Commands
| Command        | Purpose                                               |
|----------------|-------------------------------------------------------|
| /add-module    | Scaffold and implement a new module or feature        |
| /refactor      | Refactor existing code while following conventions    |
| /test          | Write and run tests for new or updated functionality  |
```
