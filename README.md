# Client Budget Plugin

Plugin de controle de custos e quota por cliente para OmniRoute.

## O que faz

```
Request entra no OmniRoute
         ↓
    onRequest hook
         ↓
  Identifica cliente (x-client-id header)
         ↓
  Verifica budget mensal/diário
         ↓
  Verifica quota mensal/diária
         ↓
  [OK] → request continua → onResponse atualiza contador
  [BLOQUEADO] → 429 + mensagem + webhook notification
```

## Instalação

```bash
# 1. Copia plugin pro diretório de plugins do OmniRoute
cp -r client-budget/ /root/.omniroute/plugins/

# 2. Edita clients.json com seus clientes
nano /root/.omniroute/plugins/client-budget/clients.json

# 3. Habilita no dashboard
#    Settings → Plugins → client-budget → Enable
```

## Configuração — `clients.json`

```json
{
  "bep": {
    "name": "BEPEX",
    "limits": {
      "budgetMonthly": 500,
      "budgetDaily": 50,
      "quotaMonthly": 5000,
      "quotaDaily": 300
    },
    "notifyAt": 80,
    "webhookUrl": "https://api.telegram.org/botTOKEN/sendMessage?chat_id=CHATID",
    "blocked": false
  },
  "mel": {
    "name": "Meu Lance",
    "limits": {
      "budgetMonthly": 300,
      "quotaMonthly": 3000
    },
    "notifyAt": 80
  },
  "sau": {
    "name": "Assistência Hospitalar",
    "limits": {
      "budgetMonthly": 200,
      "quotaMonthly": 2000
    },
    "notifyAt": 90
  }
}
```

## Como identificar o cliente

O plugin detecta o cliente por ordem de prioridade:

1. **Header `x-client-id`** (recomendado)
   ```bash
   curl -X POST https://api.claude.lab-pedro.com.br/v1/chat/completions \
     -H "x-client-id: bep" \
     -H "Authorization: Bearer sk-..." \
     -d '{"model": "claude-sonnet-4", "messages": [...]}'
   ```

2. **OmniRoute API Key** — se cada cliente tiver API key separada no OmniRoute

3. **Metadata** — via webhook ou query param

## Respostas de erro

### Budget mensal excedido
```json
{
  "error": {
    "code": 429,
    "message": "Budget mensal excedido para BEPEX (500 USD). Reset: dia 1º do mês.",
    "client": "bep",
    "used": 487.32,
    "limit": 500
  }
}
```

### Quota diária excedida
```json
{
  "error": {
    "code": 429,
    "message": "Quota diária excedida para Meu Lance (300 requests). Reset: meia-noite.",
    "client": "mel",
    "used": 300,
    "limit": 300
  }
}
```

## Webhook notifications

Configura `webhookUrl` pra receber alertas no Telegram:

```json
"webhookUrl": "https://api.telegram.org/bot123:ABC/sendMessage?chat_id=-1001234567890&text=ALERTA_BUDGET"
```

Alertas disparados:
- Budget mensal > `notifyAt`% (default: 80%)
- Budget mensal estourado
- Quota mensal estourada

## Status da quota

Via skill A2A (futuro):
```
GET /a2a → skill: client-budget-status
→ Retorna uso atual de todos os clientes
```

## Limitações

- Estimativa de custo é aproximada (~4 chars/token) — custo real vem do response
- Reset mensal: dia 1º às 00:00 UTC
- Reset diário: meia-noite UTC
- Armazenamento: JSON local em `data/client-budget-db.json`

## Roadmap

- [ ] Persistência em SQLite (substituir JSON)
- [ ] Skill A2A de status por cliente
- [ ] Dashboard UI no OmniRoute pra visualizar usage
- [ ] Alerta por email (SMTP)
- [ ] Rate limit por cliente (requests/minuto)
- [ ] Custo real vs estimado (usar usage do response)
