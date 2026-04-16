package com.techadvantage.budgetrak.data.ai

import com.techadvantage.budgetrak.data.Category

const val CSV_CATEGORIZER_PROMPT_VERSION = "v1"

fun buildCategorizerPrompt(categories: List<Category>, batchJson: String): String {
    val filtered = categories.filter { it.tag != "supercharge" && it.tag != "recurring_income" && !it.deleted }
    val categoryList = filtered.joinToString("\n") { c ->
        if (c.tag.isNotEmpty()) "  - id=${c.id} name=\"${c.name}\" tag=\"${c.tag}\""
        else                    "  - id=${c.id} name=\"${c.name}\""
    }

    return """You are a transaction categorizer for a personal-finance app. Given a list of bank transactions (merchant, amount, date) and the user's categories, assign each transaction to the single best-matching category id.

Guidance:
- Consider amount as a disambiguator. A small charge at a gas station often means food or drinks; a larger charge at the same gas station usually means fuel.
- Names matter: "Electric/Gas" means utility gas/electric service. "Transportation/Gas" means vehicle fuel and rides.
- An auto/home/life/renters insurer with no mortgage or property-tax context belongs in a pure Insurance category, not one that combines mortgage or property tax.
- Return the "Other" category only when no category clearly fits.

User's categories:
$categoryList

Transactions to categorize (JSON):
$batchJson

Return valid JSON matching the response schema. Use only categoryIds from the list above."""
}
