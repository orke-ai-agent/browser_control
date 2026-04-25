#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'net/http'
require 'optparse'
require 'time'
require 'uri'
require 'yaml'

class TrelloImporter
  DEFAULT_LABEL_COLORS = {
    'CORE' => 'purple_dark',
    'MVP' => 'yellow_dark',
    'MOB' => 'sky',
    'BE' => 'green',
    'WEB' => 'blue',
    'OPS' => 'red'
  }.freeze

  def initialize(options)
    @options = options
    @api_key = options.fetch(:api_key)
    @token = options.fetch(:token)
    @log_path = options.fetch(:log_path)
    FileUtils.mkdir_p(File.dirname(@log_path))
  end

  def run
    payload = load_yaml(@options.fetch(:file_path))
    meta = payload.fetch('meta')
    tasks = payload.fetch('tasks')

    board = request(:get, "/boards/#{@options.fetch(:board_ref)}", {
      fields: 'id,name,shortLink,url'
    })
    lists = request(:get, "/boards/#{board.fetch('id')}/lists", {
      fields: 'id,name,pos,closed'
    })
    target_list = find_list(lists, @options.fetch(:list_name))
    raise "List not found: #{@options[:list_name]}" unless target_list

    labels = request(:get, "/boards/#{board.fetch('id')}/labels", {
      fields: 'id,name,color'
    })
    label_ids = ensure_labels(board.fetch('id'), labels)

    existing_cards = request(:get, "/lists/#{target_list.fetch('id')}/cards", {
      fields: 'id,name,pos'
    })
    existing_names = existing_cards.each_with_object({}) do |card, acc|
      acc[card.fetch('name')] = true
    end

    summary = {
      board: board.fetch('name'),
      board_id: board.fetch('id'),
      list: target_list.fetch('name'),
      list_id: target_list.fetch('id'),
      created: [],
      skipped: [],
      failed: []
    }

    tasks.each_with_index do |task, index|
      name = task.fetch('task')
      if existing_names[name]
        log_event('card.skip', index: index + 1, name: name, reason: 'already_exists')
        summary[:skipped] << name
        next
      end

      desc = build_description(task, meta)
      ids = [label_ids.fetch(task.fetch('stage')), label_ids.fetch(task.fetch('layer'))].join(',')

      begin
        created = request(:post, '/cards', {
          idList: target_list.fetch('id'),
          name: name,
          desc: desc,
          pos: 'bottom',
          idLabels: ids
        })
        existing_names[name] = true
        summary[:created] << {
          index: index + 1,
          name: name,
          id: created.fetch('id')
        }
      rescue StandardError => e
        log_event('card.error', index: index + 1, name: name, error: e.message)
        summary[:failed] << {
          index: index + 1,
          name: name,
          error: e.message
        }
      end
    end

    summary
  end

  private

  def ensure_labels(board_id, labels)
    by_name = labels.each_with_object({}) do |label, acc|
      next if label['name'].to_s.strip.empty?

      acc[label.fetch('name').upcase] = label
    end

    DEFAULT_LABEL_COLORS.each_with_object({}) do |(name, color), acc|
      existing = by_name[name]
      if existing
        acc[name] = existing.fetch('id')
        next
      end

      created = request(:post, "/boards/#{board_id}/labels", {
        name: name,
        color: color
      })
      acc[name] = created.fetch('id')
    end
  end

  def find_list(lists, requested_name)
    normalized = requested_name.strip.downcase
    lists.find { |list| list.fetch('name').strip.downcase == normalized }
  end

  def build_description(task, meta)
    rate = meta['rate_per_hour']
    currency = meta['currency']

    [
      "Summary\n#{sanitize_string(task.fetch('description'))}",
      "Estimate\n- Hours: #{task.fetch('hours')}h\n- Price: #{format_money(task.fetch('price_usd'), currency)}\n- Rate: #{format_money(rate, currency)}/h",
      "Classification\n- Stage: #{task.fetch('stage')}\n- Layer: #{task.fetch('layer')}",
      "Source\n- Project: #{meta.fetch('project')}\n- Imported from: #{File.basename(@options.fetch(:file_path))}"
    ].join("\n\n")
  end

  def format_money(value, currency)
    "#{currency} #{value}"
  end

  def request(method, path, params)
    uri = URI.parse("https://api.trello.com/1#{path}")
    query = {
      key: @api_key,
      token: @token
    }.merge(params)
    uri.query = URI.encode_www_form(query)

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true

    request = case method
              when :get then Net::HTTP::Get.new(uri)
              when :post then Net::HTTP::Post.new(uri)
              else
                raise "Unsupported method: #{method}"
              end

    response = http.request(request)
    body = sanitize_string(response.body.to_s)
    log_http(method, uri.to_s, response.code.to_i, body)

    unless response.is_a?(Net::HTTPSuccess)
      raise "HTTP #{response.code}: #{body}"
    end

    return {} if body.strip.empty?

    JSON.parse(body)
  end

  def redact_url(url)
    url
      .gsub(@api_key, '[REDACTED_KEY]')
      .gsub(@token, '[REDACTED_TOKEN]')
  end

  def log_http(method, url, status, response_body)
    File.open(@log_path, 'a') do |file|
      file.puts(JSON.generate(sanitize_value({
        ts: Time.now.iso8601,
        type: 'http',
        method: method.to_s.upcase,
        url: redact_url(url),
        status: status,
        response_body: response_body
      })))
    end
  end

  def log_event(type, payload)
    File.open(@log_path, 'a') do |file|
      file.puts(JSON.generate(sanitize_value({
        ts: Time.now.iso8601,
        type: type,
        payload: payload
      })))
    end
  end

  def load_yaml(path)
    raw = File.read(path, mode: 'r:bom|utf-8')
    sanitize_value(YAML.safe_load(raw, aliases: true))
  end

  def sanitize_value(value)
    case value
    when String
      sanitize_string(value)
    when Array
      value.map { |item| sanitize_value(item) }
    when Hash
      value.each_with_object({}) do |(key, item), acc|
        acc[sanitize_value(key)] = sanitize_value(item)
      end
    else
      value
    end
  end

  def sanitize_string(value)
    value
      .to_s
      .dup
      .force_encoding('UTF-8')
      .encode('UTF-8', invalid: :replace, undef: :replace, replace: '')
  end
end

options = {
  list_name: 'TO DO',
  log_path: File.expand_path("logs/trello-import-#{Time.now.strftime('%Y%m%d-%H%M%S')}.jsonl", __dir__)
}

OptionParser.new do |parser|
  parser.on('--file PATH', 'YAML file path') { |value| options[:file_path] = File.expand_path(value) }
  parser.on('--board REF', 'Board shortLink or ID') { |value| options[:board_ref] = value }
  parser.on('--list NAME', 'Target list name') { |value| options[:list_name] = value }
  parser.on('--key VALUE', 'Trello API key') { |value| options[:api_key] = value }
  parser.on('--token VALUE', 'Trello token') { |value| options[:token] = value }
  parser.on('--log PATH', 'Log file path') { |value| options[:log_path] = File.expand_path(value) }
end.parse!

required = %i[file_path board_ref api_key token]
missing = required.reject { |key| options[key] && !options[key].to_s.strip.empty? }

unless missing.empty?
  warn "Missing required options: #{missing.join(', ')}"
  exit 1
end

summary = TrelloImporter.new(options).run
puts JSON.pretty_generate(summary)

exit 1 unless summary[:failed].empty?
