export function pagedFlowDocument() {
  return {
    id: "0:0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "登录",
        type: "PAGE",
        children: [
          {
            id: "20:1",
            name: "登录-输入",
            type: "FRAME",
            children: [
              {
                id: "20:2",
                name: "Submit",
                type: "BUTTON",
                children: [{ id: "20:4", name: "L", type: "TEXT", characters: "登录" }],
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", destinationId: "20:3", navigation: "NAVIGATE" }]
                  }
                ]
              }
            ]
          },
          {
            id: "20:3",
            name: "登录-验证",
            type: "FRAME",
            children: [
              {
                id: "20:5",
                name: "Enter",
                type: "BUTTON",
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", destinationId: "21:1", navigation: "NAVIGATE" }]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        id: "2:0",
        name: "主流程",
        type: "PAGE",
        children: [
          {
            id: "21:1",
            name: "首页",
            type: "FRAME",
            children: [
              {
                id: "21:2",
                name: "Go",
                type: "BUTTON",
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", destinationId: "21:3", navigation: "NAVIGATE" }]
                  }
                ]
              }
            ]
          },
          { id: "21:3", name: "详情", type: "FRAME", children: [] }
        ]
      }
    ]
  };
}

export function syntheticFlowDocument({ extraEntry = false } = {}) {
  const settings = extraEntry
    ? [
        {
          id: "9:1",
          name: "Settings",
          type: "FRAME",
          children: [
            {
              id: "9:2",
              name: "Open Home",
              type: "BUTTON",
              children: [{ id: "9:3", name: "L", type: "TEXT", characters: "Go home" }],
              interactions: [
                {
                  trigger: { type: "ON_CLICK" },
                  actions: [{ type: "NODE", destinationId: "10:1", navigation: "NAVIGATE" }]
                }
              ]
            }
          ]
        }
      ]
    : [];

  return {
    id: "0:0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Page 1",
        type: "PAGE",
        children: [
          ...settings,
          {
            id: "10:1",
            name: "Home",
            type: "FRAME",
            children: [
              { id: "10:5", name: "Welcome Text", type: "TEXT", characters: "Welcome Back" },
              {
                id: "10:2",
                name: "CTA Button",
                type: "INSTANCE",
                children: [{ id: "10:3", name: "CTA Label", type: "TEXT", characters: "Buy now" }],
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [
                      {
                        type: "NODE",
                        destinationId: "11:1",
                        navigation: "NAVIGATE",
                        transition: { type: "SMART_ANIMATE", duration: 0.3 }
                      }
                    ]
                  }
                ]
              }
            ]
          },
          {
            id: "11:1",
            name: "Checkout",
            type: "FRAME",
            children: [
              { id: "11:5", name: "Amount", type: "TEXT", characters: "Pay now" },
              {
                id: "11:2",
                name: "Payment Loader",
                type: "FRAME",
                interactions: [
                  {
                    trigger: { type: "AFTER_TIMEOUT", timeout: 2000 },
                    actions: [{ type: "NODE", destinationId: "12:1", navigation: "NAVIGATE" }]
                  }
                ]
              }
            ]
          },
          {
            id: "12:1",
            name: "Success",
            type: "FRAME",
            children: [
              { id: "12:5", name: "Done Text", type: "TEXT", characters: "Done" },
              {
                id: "12:2",
                name: "Back Link",
                type: "VECTOR",
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", navigation: "BACK" }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}
