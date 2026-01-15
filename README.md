# Documentation Drift Detector

## Installation

To use this action, add it to your workflow:
```yaml
- uses: jbrockSTL/doc-drift@main
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## How It Works

The action analyzes your PR using the `detect_docs_drift.js` script.
