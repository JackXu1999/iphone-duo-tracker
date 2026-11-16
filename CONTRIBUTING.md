# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Most wanted: a live "available" response

The parser (`parse.js`) has read a live "not available" response from Apple, but nobody has captured a live "available" one yet. If the watcher ever disagrees with what Apple's page shows, or you catch stock:

1. In Chrome DevTools, open the **Network** tab and filter for `fulfillment-messages`.
2. Copy the response body of the request.
3. Remove anything personal (your ZIP code, if you like) and open an issue with it attached, or add it as a test case in `test/parse.test.js`.

## Making changes

- Plain JavaScript, no build step and no dependencies. Keep it that way if you can.
- Run `npm test` before opening a pull request, and add a test for new behavior.
- To try a change, reload the extension in `chrome://extensions` and refresh the Apple tab.
- The watcher must never make requests to Apple of its own. It only reads what the page already loads and reloads the page on a slow timer. Changes that check more often or get around Apple's bot protection won't be accepted.
