<?php
$result = $client->chat()->create([
    'model' => 'gpt-3.5-turbo-0125',
    'messages' => [],
]);
$res = $http->post('https://graph.facebook.com/v20.0/me/feed');
