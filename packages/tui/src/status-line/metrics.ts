import type { Model } from "@oh-my-pi/pi-catalog/types";
import { formatNumber, normalizePremiumRequests } from "@oh-my-pi/pi-utils";
import type { Theme } from "../theme";

export { normalizePremiumRequests } from "@oh-my-pi/pi-utils";

/** Inputs whose differences are intentionally preserved between current status segments and the legacy footer. */
export interface BillingSummaryOptions {
	readonly cost: number;
	readonly usingSubscription: boolean;
	/** The active model uses ChatGPT plan/credit usage instead of an API dollar rate. */
	readonly usingChatGPTPlan?: boolean;
	/** Previously recorded usage includes an amount that cannot be expressed in dollars. */
	readonly hasUnpricedUsage?: boolean;
	readonly premiumRequests: number;
	readonly fractionDigits: number;
	readonly pricingPeriod?: "peak" | "off-peak";
	/** Subagent-tree spend, rendered `(+…)` after the session's own spend; `cost` excludes it. */
	readonly subagentCost?: number;
	readonly advisor?: {
		readonly cost: number;
		readonly usingSubscription: boolean;
	};
}

type BillingUnit = "metered" | "subscription";

/** Read the compiled request contract instead of inferring billing from a provider name or token. */
export function isUsingChatGPTPlan(model: Model | undefined): boolean {
	const compat = model?.compat;
	return (
		compat !== undefined && "responsesRequestContract" in compat && compat.responsesRequestContract === "chatgpt"
	);
}

/** `showUnit: false` omits the `$`/subscription symbol when the summary already printed it. */
function formatSpend(
	amount: number,
	usingSubscription: boolean,
	fractionDigits: number,
	uiTheme: Theme,
	showUnit: boolean,
): string {
	const formatted = amount.toFixed(fractionDigits);
	if (!showUnit) return formatted;
	if (!usingSubscription) return `$${formatted}`;
	if (uiTheme.getSymbolPreset() === "nerd") {
		const icon = uiTheme.icon.subscription;
		return icon ? `${icon} ${formatted}` : `S${formatted}`;
	}
	return `S${formatted}`;
}

function formatAdvisorSpend(
	amount: number,
	usingSubscription: boolean,
	fractionDigits: number,
	uiTheme: Theme,
	showUnit: boolean,
): string {
	const spend = formatSpend(amount, usingSubscription, fractionDigits, uiTheme, showUnit);
	const icon = uiTheme.icon.advisor;
	return icon && icon !== "(adv)" ? `${icon} ${spend}` : `${spend} (adv)`;
}

/**
 * Shared billing metric presentation. Callers select precision explicitly so
 * the legacy footer keeps three decimals while current status segments keep two.
 * A unit symbol (`$` or the subscription mark) is printed at most once; later
 * amounts billed the same way render bare.
 */
export function formatBillingSummary(options: BillingSummaryOptions, uiTheme: Theme): string | undefined {
	const premiumRequests = normalizePremiumRequests(options.premiumRequests);
	const advisorCost = options.advisor?.cost ?? 0;
	const subagentCost = options.subagentCost ?? 0;
	const usingSubscription = options.usingSubscription && !options.usingChatGPTPlan;
	if (
		!options.cost &&
		!subagentCost &&
		!advisorCost &&
		!options.usingSubscription &&
		!options.usingChatGPTPlan &&
		!options.hasUnpricedUsage &&
		!premiumRequests &&
		!options.pricingPeriod
	) {
		return undefined;
	}

	const parts: string[] = [];
	let shownUnit: BillingUnit | undefined;
	const primaryUnit: BillingUnit = usingSubscription ? "subscription" : "metered";
	if (options.cost || options.pricingPeriod || subagentCost) {
		parts.push(formatSpend(options.cost, usingSubscription, options.fractionDigits, uiTheme, true));
		shownUnit = primaryUnit;
	} else if (usingSubscription) {
		parts.push(
			uiTheme.getSymbolPreset() === "nerd" && uiTheme.icon.subscription ? uiTheme.icon.subscription : "(sub)",
		);
		shownUnit = primaryUnit;
	}
	// Always follows the primary spend, which already carries the unit.
	if (subagentCost) parts.push(`(+${subagentCost.toFixed(options.fractionDigits)})`);
	if (options.pricingPeriod) parts.push(options.pricingPeriod === "peak" ? "↑" : "↓");
	if (premiumRequests) parts.push(`★ ${formatNumber(premiumRequests)}`);
	if (advisorCost && options.advisor) {
		const prefix = parts.length > 0 ? "+ " : "";
		const advisorUnit: BillingUnit = options.advisor.usingSubscription ? "subscription" : "metered";
		parts.push(
			`${prefix}${formatAdvisorSpend(
				advisorCost,
				options.advisor.usingSubscription,
				options.fractionDigits,
				uiTheme,
				shownUnit !== advisorUnit,
			)}`,
		);
	}
	if (options.usingChatGPTPlan) {
		parts.push(parts.length > 0 ? "+ ChatGPT plan" : "ChatGPT plan");
	} else if (options.hasUnpricedUsage) {
		parts.push(parts.length > 0 ? "· contains unpriced usage" : "contains unpriced usage");
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}
