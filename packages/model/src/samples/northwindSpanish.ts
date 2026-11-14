import type { NorthwindStage } from './northwind';
import { SYSTEM_DRAFT_ONLY, SYSTEM_ES_US_OWN_DATA } from './spanishSystem';

/**
 * Spanish (US) for the Northwind Energy bill, written for the example and approved with it — except the few texts in
 * `NORTHWIND_ES_DRAFT_ONLY`, which stay drafts on purpose so Content & Translations has work to show. The one such text
 * a customer can meet (the credit-balance message added in the working version) is the sample's labelled
 * demonstration blocker for one Spanish-speaking customer in credit.
 */
export const NORTHWIND_ES_DRAFT_ONLY: ReadonlySet<string> = new Set(['pay-credit', '@title/pay-credit', ...SYSTEM_DRAFT_ONLY]);

export function NORTHWIND_ES(stage: NorthwindStage): Record<string, string> {
  return {
    ...SYSTEM_ES_US_OWN_DATA,
    '@issuer-logo/image.alt': 'Logotipo de Northwind Energy (empresa de servicios ficticia)',
    '@slip-logo/image.alt': 'Logotipo de Northwind Energy (empresa de servicios ficticia)',
    '@document-header/headerFooter': 'DATOS SINTÉTICOS DE DEMOSTRACIÓN · Northwind Energy es ficticia · No es una factura real',
    '@bill-title/content': '# Su factura de energía\nFecha de la factura {{custom.billDate}} · Cuenta **{{custom.accountNumber}}**\nDirección del servicio: {{calc.serviceAddress}}\nPeríodo de facturación del {{custom.periodStart}} al {{custom.periodEnd}} ({{calc.billingDays}} días)',
    '@amount-due/label': 'Total a pagar',
    '@due-date/label': 'Pague a más tardar el',
    '@running-header/headerFooter': 'Factura de Northwind Energy · Cuenta {{custom.accountNumber}} · {{customer.givenName}} {{customer.familyName}}',
    '@page-footer/headerFooter': 'Northwind Energy (ficticia) · Demostración sintética: no es una factura real',
    '@greeting/content': 'Hola, {{customer.givenName}}: esta es su factura de Northwind Energy por {{calc.billingDays}} días de servicio.',
    '@previous-balance/label': 'Saldo anterior',
    '@payments-received/label': '− Pagos recibidos',
    '@current-charges/label': '+ Cargos del período',
    '@taxes-fees/label': '+ Impuestos y cargos',
    '@total-due/label': '= Total a pagar',
    '@electricity-heading/content': '## Electricidad',
    '@electricity-use/content': 'Usó **{{calc.electricUsage}} kWh** en {{calc.billingDays}} días, un promedio de {{calc.avgDailyKwh}} kWh por día.\nSu tarifa de distribución es de {{calc.deliveryRate}}¢ por kWh, la tarifa para {{calc.deliveryBand}}, por lo que la distribución de electricidad cuesta {{calc.deliveryCharge}} este mes. La tarifa de suministro es de {{calc.supplyRate}}¢ por kWh.\nSu mes de mayor consumo del último año fue de {{calc.peakMonthKwh}} kWh. Su próxima lectura del medidor será alrededor del {{calc.nextReadDate}}.',
    '@electricity-chart/chart.title': 'Consumo de electricidad, últimos 6 meses (kWh)',
    '@electricity-compare/content': 'En el mismo mes del año pasado usó {{custom.lastYearKwh}} kWh. Su consumo cambió un {{calc.kwhChangePct}}%.',
    '@gas-heading/content': '## Gas natural',
    '@gas-use/content': 'Usó **{{calc.gasUsage}} termias** de gas natural en {{calc.billingDays}} días.\nEn el mismo mes del año pasado usó {{custom.lastYearTherms}} termias.\nLa distribución de gas cuesta 41.20¢ y el suministro de gas 63.85¢ por termia.',
    '@gas-chart/chart.title': 'Consumo de gas, últimos 6 meses (termias)',
    '@dual-fuel-note/content': '**Ahorro por doble servicio.** Como nos compra electricidad y gas, su cargo fijo de gas es $2.00 más bajo cada mes.',
    '@estimated-read-note/content': '**Acerca de las lecturas estimadas.** Esta vez no pudimos leer {{calc.estimatedReads}} de sus medidores, así que estimamos la lectura según su consumo anterior y el clima. Los kilovatios-hora estimados se corrigen automáticamente en su próxima lectura real.',
    '@meter-table/caption': 'Lecturas del medidor',
    '@meter-table/col.fuel': 'Servicio',
    '@meter-table/col.meterNumber': 'Medidor',
    '@meter-table/col.previousRead': 'Anterior',
    '@meter-table/col.currentRead': 'Actual',
    '@meter-table/col.readType': 'Tipo de lectura',
    '@meter-table/col.usage': 'Consumo',
    '@meter-table/col.unit': 'Unidad',
    '@charges-table/caption': 'Sus cargos de este período',
    '@charges-table/col.fuel': 'Servicio',
    '@charges-table/col.description': 'Descripción',
    '@charges-table/col.quantity': 'Cantidad',
    '@charges-table/col.unit': 'Unidad',
    '@charges-table/col.rate': 'Tarifa',
    '@charges-table/col.amountCents': 'Importe',
    '@winter-help/content': '## Ayuda con las facturas de calefacción en invierno\nDe noviembre a marzo, los hogares que reúnan los requisitos pueden recibir ayuda con los costos de calefacción del Programa de Asistencia de Energía para el Hogar de Calder Bay (ficticio). Llame al 1-800-555-0142 o visite example.com/northwind/help para presentar su solicitud. Solicitarla no afecta su servicio.',
    '@pay-online/action.label': 'Pague su factura en línea',
    '@pay-online/action.fallback': 'Pague en línea en example.com/northwind/pay, por teléfono al 1-800-555-0148 o por correo con el talón de pago.',
    '@pay-qr/qr.caption': 'Escanee para pagar en línea',
    '@slip-cut/content': '*Desprenda esta parte y devuélvala con su pago.*',
    '@slip-remit/content': '**Haga los cheques a nombre de Northwind Energy**\nCentro de Pagos (ficticio), PO Box 2041, Calder Bay, MI 49012',
    '@slip-account/content': '**Talón de pago** · Cuenta **{{custom.accountNumber}}**\n{{customer.givenName}} {{customer.familyName}}\nTotal a pagar **{{calc.totalDue}}** a más tardar el {{custom.dueDate}}\nImporte adjunto: $ ______________',
    '@title/pay-standard': 'Cómo pagar su factura',
    '@title/pay-overdue': 'Su cuenta tiene un pago vencido',
    '@title/pay-plan': 'Su plan de pagos',
    '@title/pay-autopay': 'El pago automático está activado',
    '@title/rate-upcoming': 'Su tarifa de suministro de electricidad va a cambiar',
    '@title/rate-new': 'Su nueva tarifa de suministro de electricidad',
    '@title/high-usage-tips': 'Usó más electricidad que el año pasado',
    '@email/subject': 'Su factura de Northwind Energy del {{custom.billDate}} está lista',
    '@email/preheader': 'Su factura por {{calc.billingDays}} días de servicio está lista. {{keyFacts}}',
    '@email/title': 'Su factura de energía está lista',
    '@email/intro': 'Hola, {{customer.givenName}}: la factura de su cuenta {{custom.accountNumber}} ya está disponible.',
    '@email/keyFactsHeading': 'Su factura de un vistazo',
    '@email/closing': 'Gracias por ser cliente de Northwind Energy.',
    '@sms/text': 'DEMO Northwind Energy: Ya puede ver su factura. Saldo de la cuenta {{calc.totalDue}}, vence el {{custom.dueDate}}. Vea y pague: {{link}}',
    'pay-standard': stage === 'release1'
      ? 'Pague **{{calc.totalDue}}** a más tardar el **{{custom.dueDate}}**, {{calc.daysUntilDue}} días después de la fecha de esta factura. Puede pagar en línea, por teléfono o por correo.'
      : 'Pague **{{calc.totalDue}}** a más tardar el **{{custom.dueDate}}**, {{calc.daysUntilDue}} días después de la fecha de esta factura. Puede pagar en línea, por teléfono o por correo con el talón de pago de la última página.',
    'pay-overdue': 'No hemos recibido el pago de su saldo anterior. Pague **{{calc.totalDue}}** a más tardar el **{{custom.dueDate}}**. Si no lo recibimos para esa fecha, se agregará un cargo por pago tardío de **{{calc.lateFee}}** a su próxima factura. Si tiene dificultades para pagar, llámenos al 1-800-555-0148 y acordaremos un plan de pagos con usted.',
    'pay-plan': 'Usted tiene un plan de pagos. La cuota de este mes es de **{{custom.planInstallmentCents}}** y vence el **{{custom.dueDate}}**. El resto de su saldo se reparte entre las cuotas restantes. Si paga cada cuota a tiempo, su plan se mantiene.',
    'pay-autopay': 'No tiene que hacer nada. Cobraremos **{{calc.totalDue}}** de su cuenta bancaria el **{{custom.dueDate}}**. Para pagar otro importe, cámbielo en línea al menos tres días antes.',
    ...(stage === 'working' ? {
      'pay-credit': 'Tiene un crédito de **{{calc.creditAmount}}** en su cuenta, así que no debe pagar nada este mes. Usaremos el crédito en su próxima factura.',
      '@title/pay-credit': 'Su cuenta tiene un crédito',
    } : {}),
    'rate-upcoming': 'A partir del 1 de diciembre de 2026, la tarifa de suministro de electricidad cambia de 7.85¢ a 8.42¢ por kWh, según lo aprobó la Comisión de Servicios Públicos de Calder Bay (ficticia). Esta factura usa la tarifa actual de {{calc.supplyRate}}¢ por kWh; su próxima factura usará la nueva tarifa.',
    'rate-new': 'Desde el 1 de diciembre de 2026, la tarifa de suministro de electricidad es de {{calc.supplyRate}}¢ por kWh (antes era de 7.85¢). La Comisión de Servicios Públicos de Calder Bay (ficticia) aprobó el cambio. Esta factura usa la nueva tarifa.',
    'high-usage-tips': 'Su consumo de electricidad es un {{calc.kwhChangePct}}% mayor que en el mismo mes del año pasado. La calefacción y los días más cortos suelen aumentar el consumo en invierno. Una revisión energética gratuita de su hogar puede ayudarle a ahorrar: llame al 1-800-555-0148 para programarla.',
  };
}
